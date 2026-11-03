/**
 * Content-Security-Policy connect-src for a server chosen at runtime (open-source step 5c).
 *
 * index.html carries the community policy with `connect-src 'self' https: wss: blob:` (+ localhost for development):
 * the server is typed by the user, so the static policy cannot name it — the same choice as AegisTrans. A meta CSP can be
 * tightened but never relaxed for the life of a page, so at boot (main.tsx imports services/connectPolicyBoot.ts first)
 * the app adds a second policy that allows only the active server's API and broker origins (plus 'self' and blob:; the
 * official edition adds its csp.json list while the official server is active). After that, fetch / XHR / WebSocket /
 * EventSource requests from the page — a script injected by an XSS included — reach only the chosen server. connect-src
 * does not cover everything: navigation (links, window.location), WebRTC ICE (STUN / TURN and the peers' addresses) and
 * what the other directives allow (images, media from blob:/data:) are not limited by it.
 *
 * Not narrowed: before a server is chosen (community first run: discovery must reach whatever URL the user types), and
 * for exactly one page load after the user asks to change the server (beginServerPick: Settings / welcome screen reload
 * into "pick" mode so discovery can reach the new URL; switching reloads again, narrowed to the new server). The pick
 * flag is consumed at boot (consumeServerPick, security review L1): a reload, or a script that sets the flag and
 * reloads, gets one un-narrowed page, and that page only offers the server choice — no account is unlocked there
 * (ChatAuthScreen) and no MQTT token is requested (mqttCredential.requestMqttToken).
 */
import { getActiveServer, type ActiveServer } from './serverChoice';
import { connectSources as editionConnectSources } from '@ext/server';

export const SERVER_PICK_FLAG = 'aegis_server_pick';

let narrowedTo: string | null = null;
/** this page was loaded to pick a server (the boot consumed the flag) */
let pickThisPage = false;

/** scheme://host[:port] of a URL (CSP source expression); null if malformed */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/** The connect-src sources while `server` is active. */
export function connectSourcesFor(server: ActiveServer, editionExtras: readonly string[] = editionConnectSources): string[] {
  const out = ["'self'", 'blob:'];
  for (const url of [server.apiUrl, server.mqttUrl]) {
    const o = originOf(url);
    if (o && !out.includes(o)) out.push(o);
  }
  if (server.isOfficial) for (const s of editionExtras) if (!out.includes(s)) out.push(s);
  return out;
}

/**
 * Boot (connectPolicyBoot.ts, before anything else): read the one-shot pick flag and remove it, so pick mode lasts this page
 * load only. Returns whether this page is a pick page.
 */
export function consumeServerPick(): boolean {
  let requested = false;
  try {
    requested = sessionStorage.getItem(SERVER_PICK_FLAG) === '1';
    sessionStorage.removeItem(SERVER_PICK_FLAG);
  } catch { /* no storage: never a pick page */ }
  pickThisPage = requested;
  return requested;
}

/** This page is a pick page, or a pick was just requested (beginServerPick, reloading). */
export function serverPickRequested(): boolean {
  if (pickThisPage) return true;
  try { return sessionStorage.getItem(SERVER_PICK_FLAG) === '1'; } catch { return false; }
}

/** Add the narrowed connect-src policy for the active server (once per page). Returns whether the page is narrowed. */
export function narrowConnectSrc(doc: Document = document): boolean {
  if (narrowedTo) return true;
  const server = getActiveServer();
  if (!server || serverPickRequested()) return false;
  const policy = `connect-src ${connectSourcesFor(server).join(' ')}`;
  const meta = doc.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = policy;
  doc.head.appendChild(meta);
  narrowedTo = policy;
  return true;
}

/** The narrowed policy of this page (null = not narrowed). */
export function narrowedConnectPolicy(): string | null {
  return narrowedTo;
}

/** Change server from a narrowed page: reload once without the narrowing so discovery can reach the typed URL. */
export function beginServerPick(): void {
  try { sessionStorage.setItem(SERVER_PICK_FLAG, '1'); } catch { /* no storage: discovery stays limited to this server */ }
  window.location.reload();
}

/** The pick is over (switched, or cancelled): the next load is narrowed again. */
export function endServerPick(): void {
  pickThisPage = false;
  try { sessionStorage.removeItem(SERVER_PICK_FLAG); } catch { /* */ }
}

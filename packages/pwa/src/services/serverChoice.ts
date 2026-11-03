/**
 * Which chat server this install talks to (runtime choice; open-source step 5c, ported from AegisTrans
 * services/serverChoice.ts on oss/prep).
 *
 * - Default server per edition ('@ext/server'): the community edition has NONE — the app asks on first run
 *   (ext/chat/ChatAuthScreen, step 1); the official edition defaults to the official service
 *   (src/ext-official/official-server.json, public URLs only). A self-hoster's own build can set VITE_DEFAULT_API_URL
 *   (+ VITE_DEFAULT_MQTT_URL, …, see packages/pwa/.env.example): then every default value comes from those variables,
 *   never half official, half self-hosted.
 * - A chosen server: the user types only the API URL; the broker URL, STUN servers, Web Push key, registration policy and
 *   links come from the server's GET {api}/api/chat/server-config (api/chat/server_config.py). Stored in localStorage
 *   (one per install).
 * - Switching = disconnect + lock + store + reload (services/serverSwitch.ts, storeServerForNextLoad), so the value is
 *   constant for a signed-in page and is read once. Accounts are per server: local data belongs to the server it was created on (services/serverAccount.ts).
 *
 * This file must not import Capacitor or React (review tests bundle it in Node).
 */
import { defaultServer as editionDefault } from '@ext/server';
import type { EditionServerConfig } from '../ext/types';

export const SERVER_STORAGE_KEY = 'aegistalk_server';
/** local data owner key of the build's default server (old installs without an owner record count as this one) */
export const DEFAULT_SERVER_KEY = 'default';
export const DISCOVERY_PATH = '/api/chat/server-config';
export const SERVICE_ID = 'aegistalk-chat';
export const SUPPORTED_API_VERSION = 1;
const DISCOVERY_TIMEOUT_MS = 10_000;

export type RegistrationPolicy = 'open' | 'invite' | 'closed' | 'external';
const POLICIES: readonly RegistrationPolicy[] = ['open', 'invite', 'closed', 'external'];

export interface ServerLinks {
  privacy?: string;
  terms?: string;
  support?: string;
  supportEmail?: string;
}

/** A server the user chose, stored locally (validated with parseCustomServer on every read). */
export interface CustomServer {
  v: 1;
  apiUrl: string;
  mqttUrl: string;
  /** STUN servers the server names (none → the app's built-in public ones) */
  stunUrls?: string[];
  /** keys-only registration policy at the time it was checked (the server enforces the live one) */
  registration: RegistrationPolicy;
  apiVersion: number;
  name?: string;
  links?: ServerLinks;
}

export interface ActiveServer {
  isDefault: boolean;
  /** the official AegisTalk service (official edition default); a self-hoster's default and chosen servers are false */
  isOfficial: boolean;
  /** local data owner key: 'default' or 'custom:<apiUrl>' */
  key: string;
  apiUrl: string;
  mqttUrl: string;
  stunUrls?: string[];
  registration?: RegistrationPolicy;
  name?: string;
  links: ServerLinks;
}

type Env = Record<string, string | undefined>;

function buildEnv(): Env {
  try {
    return (import.meta.env as unknown as Env | undefined) ?? {};
  } catch {
    return {};
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

export type UrlKind = 'api' | 'mqtt' | 'web';
export type UrlCheck = { ok: true; url: string } | { ok: false; reason: 'invalid' | 'insecure' | 'credentials' | 'query' };

/**
 * Check and normalise a URL: api / web only https (http only for localhost development), mqtt only wss (ws only for
 * localhost). No user:password, no query string or fragment; trailing slashes removed.
 */
export function normalizeServerUrl(raw: string, kind: UrlKind): UrlCheck {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const secure = kind === 'mqtt' ? 'wss:' : 'https:';
  const plain = kind === 'mqtt' ? 'ws:' : 'http:';
  if (u.protocol !== secure && !(u.protocol === plain && isLocalHost(u.hostname))) {
    return { ok: false, reason: u.protocol === plain ? 'insecure' : 'invalid' };
  }
  if (!u.hostname) return { ok: false, reason: 'invalid' };
  if (u.username || u.password) return { ok: false, reason: 'credentials' };
  if (u.search || u.hash || String(raw).includes('?') || String(raw).includes('#')) return { ok: false, reason: 'query' };
  return { ok: true, url: stripTrailingSlash(`${u.protocol}//${u.host}${u.pathname}`) };
}

/** STUN only (the app never uses TURN: message content must not pass a relay) */
function isStunUrl(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 200 && /^stuns?:[^\s/?#]+$/.test(v);
}

function cleanLinks(raw: unknown): ServerLinks {
  if (!raw || typeof raw !== 'object') return {};
  const out: ServerLinks = {};
  for (const k of ['privacy', 'terms', 'support'] as const) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string') {
      const c = normalizeServerUrl(v, 'web');
      if (c.ok) out[k] = c.url;
    }
  }
  const mail = (raw as Record<string, unknown>).supportEmail;
  if (typeof mail === 'string' && mail.length <= 200 && /^[^\s@]+@[^\s@]+$/.test(mail)) out.supportEmail = mail;
  return out;
}

function fromEditionConfig(cfg: EditionServerConfig, isOfficial: boolean): ActiveServer | null {
  const api = normalizeServerUrl(cfg.apiUrl, 'api');
  const mqtt = normalizeServerUrl(cfg.mqttUrl ?? '', 'mqtt');
  if (!api.ok || !mqtt.ok) return null;
  const stun = (cfg.stunUrls ?? []).filter(isStunUrl);
  return {
    isDefault: true,
    isOfficial,
    key: DEFAULT_SERVER_KEY,
    apiUrl: api.url,
    mqttUrl: mqtt.url,
    stunUrls: stun.length ? stun : undefined,
    registration: cfg.registration && POLICIES.includes(cfg.registration) ? cfg.registration : undefined,
    name: cfg.name || undefined,
    links: cleanLinks(cfg.links),
  };
}

/** The build's default server: a self-hoster's VITE_DEFAULT_API_URL, else the edition's ('@ext/server'; community: none). */
function defaultServer(): ActiveServer | null {
  const e = buildEnv();
  if (e.VITE_DEFAULT_API_URL) {
    return fromEditionConfig({
      apiUrl: e.VITE_DEFAULT_API_URL,
      mqttUrl: e.VITE_DEFAULT_MQTT_URL ?? '',
      stunUrls: (e.VITE_DEFAULT_STUN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      name: e.VITE_DEFAULT_SERVER_NAME,
      links: { privacy: e.VITE_DEFAULT_PRIVACY_URL, terms: e.VITE_DEFAULT_TERMS_URL, support: e.VITE_DEFAULT_SUPPORT_URL },
    }, false);
  }
  return editionDefault ? fromEditionConfig(editionDefault, true) : null;
}

/** Does this build have a default server at all (community edition: no — it asks on first run)? */
export function hasDefaultServer(): boolean {
  return defaultServer() !== null;
}

/** Is the build's default server the official service (false for a self-hoster's VITE_DEFAULT_API_URL and for none)? */
export function defaultServerIsOfficial(): boolean {
  return defaultServer()?.isOfficial ?? false;
}

/** Validate data from localStorage, a recovery kit or server-config; null if it does not qualify. */
export function parseCustomServer(raw: unknown): CustomServer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== undefined && r.v !== 1) return null;
  if (typeof r.apiUrl !== 'string' || typeof r.mqttUrl !== 'string') return null;
  const api = normalizeServerUrl(r.apiUrl, 'api');
  const mqtt = normalizeServerUrl(r.mqttUrl, 'mqtt');
  if (!api.ok || !mqtt.ok) return null;
  if (typeof r.registration !== 'string' || !POLICIES.includes(r.registration as RegistrationPolicy)) return null;
  if (r.apiVersion !== SUPPORTED_API_VERSION) return null;
  const stun = Array.isArray(r.stunUrls) ? r.stunUrls.filter(isStunUrl).slice(0, 8) : [];
  return {
    v: 1,
    apiUrl: api.url,
    mqttUrl: mqtt.url,
    ...(stun.length ? { stunUrls: stun } : {}),
    registration: r.registration as RegistrationPolicy,
    apiVersion: SUPPORTED_API_VERSION,
    ...(typeof r.name === 'string' && r.name.trim() ? { name: r.name.trim().slice(0, 60) } : {}),
    links: cleanLinks(r.links),
  };
}

export function readCustomServer(): CustomServer | null {
  try {
    const raw = localStorage.getItem(SERVER_STORAGE_KEY);
    return raw ? parseCustomServer(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Display: the host of a URL; null if missing or malformed. */
export function webHost(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function customServerKey(apiUrl: string): string {
  return `custom:${apiUrl}`;
}

function fromCustom(custom: CustomServer): ActiveServer {
  return {
    isDefault: false,
    isOfficial: false,
    key: customServerKey(custom.apiUrl),
    apiUrl: custom.apiUrl,
    mqttUrl: custom.mqttUrl,
    stunUrls: custom.stunUrls,
    registration: custom.registration,
    name: custom.name,
    links: custom.links ?? {},
  };
}

let cached: { server: ActiveServer | null } | null = null;

/**
 * The server in use. Fixed for a signed-in page: switching stores the next choice without touching this cache and reloads
 * (storeServerForNextLoad). Only the pre-login paths (kit restore, tests) change it in place (saveCustomServer). null = none
 * chosen yet (community edition before the first-run choice) — nothing may talk to a server then.
 */
export function getActiveServer(): ActiveServer | null {
  if (cached) return cached.server;
  const custom = readCustomServer();
  cached = { server: custom ? fromCustom(custom) : defaultServer() };
  return cached.server;
}

/** Tests only: forget the cached choice. */
export function resetActiveServerCache(): void {
  cached = null;
}

/** The build's default server (Settings shows which one "official" / "default" is); null in the community edition. */
export function getDefaultServer(): ActiveServer | null {
  return defaultServer();
}

/** The server as it goes into a recovery kit: the chosen one, or null for the build's default. */
export function activeServerForKit(): CustomServer | null {
  return readCustomServer();
}

/** Save a chosen server; throws if it cannot be stored (private mode, quota) — the caller reports it. */
export function saveCustomServer(server: CustomServer): void {
  localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(server));
  cached = null;
}

export function clearCustomServer(): void {
  localStorage.removeItem(SERVER_STORAGE_KEY);
  cached = null;
}

/**
 * Store the server for the next page load (switching, security review L2): the in-page choice stays as it is, so nothing
 * still running on this page (token refresh, device-claim heartbeat, push) sends the old account's signed requests to the
 * new server before the reload. Throws if it cannot be stored.
 */
export function storeServerForNextLoad(next: CustomServer | null): void {
  if (next) localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(next));
  else localStorage.removeItem(SERVER_STORAGE_KEY);
}

export type DiscoveryFailure = 'invalid_url' | 'insecure_url' | 'unreachable' | 'not_aegistalk' | 'unsupported_version' | 'bad_config';
export type DiscoveryResult =
  | { ok: true; server: CustomServer; webPush: boolean }
  | { ok: false; reason: DiscoveryFailure };

/**
 * Ask a server for its connection settings: GET {apiUrl}/api/chat/server-config (no login, no secrets).
 * service must be "aegistalk-chat", api_version a version this app speaks, mqtt_url a wss:// URL (ws:// on localhost).
 */
export async function discoverServer(rawApiUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiscoveryResult> {
  const api = normalizeServerUrl(rawApiUrl, 'api');
  if (!api.ok) return { ok: false, reason: api.reason === 'insecure' ? 'insecure_url' : 'invalid_url' };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS) : null;
  let body: unknown;
  try {
    const resp = await fetchImpl(`${api.url}${DISCOVERY_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: ctrl?.signal,
    });
    if (!resp.ok) return { ok: false, reason: resp.status === 404 ? 'not_aegistalk' : 'bad_config' };
    body = await resp.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!body || typeof body !== 'object' || (body as Record<string, unknown>).service !== SERVICE_ID) {
    return { ok: false, reason: 'not_aegistalk' };
  }
  const b = body as Record<string, unknown>;
  if (b.api_version !== SUPPORTED_API_VERSION) return { ok: false, reason: 'unsupported_version' };
  const server = parseCustomServer({
    v: 1,
    apiUrl: api.url,
    mqttUrl: b.mqtt_url,
    stunUrls: b.stun_urls,
    registration: b.registration,
    apiVersion: b.api_version,
    name: b.name,
    links: b.links,
  });
  if (!server) return { ok: false, reason: 'bad_config' };
  const push = b.push as Record<string, unknown> | undefined;
  return { ok: true, server, webPush: !!push && push.webpush === true && typeof b.vapid_public_key === 'string' };
}

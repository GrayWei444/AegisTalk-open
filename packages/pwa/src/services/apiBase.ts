/**
 * Where the chat server is (open-source step 5c): every API and broker URL of the app comes from here, never from a
 * hard-coded host. The server is the one chosen at runtime (services/serverChoice.ts: the community edition asks on first
 * run, the official edition defaults to the official service). It is fixed for a page lifetime (switching reloads).
 *
 * No server chosen yet (community edition before the first-run choice) → NoServerError: nothing may silently fall back
 * to some other host. Callers that run before the choice (none should) catch it like any network error.
 *
 *   fetch(`${apiBase()}/api/mqtt/token`, …)
 */
import { getActiveServer } from './serverChoice';

export class NoServerError extends Error {
  constructor() {
    super('no chat server chosen yet');
    this.name = 'NoServerError';
  }
}

/** API base URL of the active server (no trailing slash). */
export function apiBase(): string {
  const server = getActiveServer();
  if (!server) throw new NoServerError();
  return server.apiUrl;
}

/** MQTT broker URL of the active server (wss://, ws:// only on localhost). */
export function brokerUrl(): string {
  const server = getActiveServer();
  if (!server) throw new NoServerError();
  return server.mqttUrl;
}

/** STUN servers the active server names; null = none (the app uses its built-in public STUN servers). */
export function serverStunUrls(): string[] | null {
  const urls = getActiveServer()?.stunUrls;
  return urls && urls.length ? urls : null;
}

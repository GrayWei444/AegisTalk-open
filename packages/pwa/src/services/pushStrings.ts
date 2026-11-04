/**
 * The notification texts the service worker shows (services/pushDisplay.ts), in the app's language.
 *
 * The service worker cannot read the language setting (localStorage) and does not bundle the locale tables, so the
 * page writes the translated texts into the Cache API whenever the language is loaded or changed
 * (i18n/store → notificationStringsPlugin.syncNotificationStrings) and the service worker reads them for each
 * notification. Only same-origin code can write this cache; the texts are still checked (cleanPushStrings) and fall
 * back to DEFAULT_PUSH_STRINGS. Nothing from a push is used. This file touches no window / document API.
 */
import { cleanPushStrings, DEFAULT_PUSH_STRINGS, type PushStrings } from './pushDisplay';

const CACHE = 'aegis-push-strings';
const KEY = '/aegis-push-strings.json';

export async function savePushStrings(strings: PushStrings): Promise<void> {
  if (typeof caches === 'undefined') return;
  const clean = cleanPushStrings(strings);
  if (!clean) return;
  const cache = await caches.open(CACHE);
  await cache.put(KEY, new Response(JSON.stringify(clean), { headers: { 'Content-Type': 'application/json' } }));
}

export async function loadPushStrings(): Promise<PushStrings> {
  try {
    if (typeof caches === 'undefined') return DEFAULT_PUSH_STRINGS;
    const res = await (await caches.open(CACHE)).match(KEY);
    return (res && cleanPushStrings(await res.json())) || DEFAULT_PUSH_STRINGS;
  } catch {
    return DEFAULT_PUSH_STRINGS;
  }
}

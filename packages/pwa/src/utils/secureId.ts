/**
 * Cryptographically secure ID generation.
 *
 * Replaces `Math.random().toString(36)` patterns with `crypto.getRandomValues()`
 * for all runtime IDs (messages, groups, alerts, etc.).
 */

/** Generate a random hex suffix using crypto.getRandomValues */
function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a prefixed ID: `{prefix}-{timestamp}-{7-char hex}` */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomHex(4).slice(0, 7)}`;
}

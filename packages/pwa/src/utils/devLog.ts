/**
 * Development-only logging utility.
 *
 * Vite statically replaces `import.meta.env.DEV` at build time:
 *  - dev  → true  (logs execute)
 *  - prod → false (entire call is dead-code-eliminated)
 *
 * Use for logs that contain sensitive metadata (keys, message content,
 * session data, risk scores). Keep regular console.error for real errors.
 */

 

const isDebug = import.meta.env.DEV || import.meta.env.MODE === 'debug';

export function devLog(...args: unknown[]): void {
  if (isDebug) {
    console.log(...args);
  }
}

export function devWarn(...args: unknown[]): void {
  if (isDebug) {
    console.warn(...args);
  }
}

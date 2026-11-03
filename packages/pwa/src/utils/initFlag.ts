/**
 * App initialization flag — shared between main.tsx and AppProvider
 * Separate module to avoid circular imports
 */

let appInitCompleted = false;

export function markAppInitCompleted(): void {
  appInitCompleted = true;
}

export function isAppInitCompleted(): boolean {
  return appInitCompleted;
}

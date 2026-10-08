// Browser storage is a convenience for this browser's own preferences: when it is not to be
// had (private windows, blocked site data), the page still works with the defaults.

export function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered, then.
  }
}

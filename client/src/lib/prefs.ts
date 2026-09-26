// Small per-device UI preferences (last folder, last model). Never store tokens here.
// Storage can be unavailable (private mode). Then the defaults apply.

const PREFIX = "harness.";

export function loadPref(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(PREFIX + key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Ignore: the preference is a convenience.
  }
}

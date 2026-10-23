/** Light (ISA-101 grey) and dark (control-room) themes, driven by CSS custom properties. */

export type Theme = 'light' | 'dark';

const KEY = 'conveyor-twin-theme';

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // storage unavailable (private window, file:// restrictions) — fall back to default
  }
  return 'light';
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // preference simply isn't remembered
  }
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

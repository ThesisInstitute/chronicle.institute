/**
 * The register the reader sees: the system's, or one they chose.
 *
 * Three states, not two. "System" is a real choice — the default — and it is
 * held as the absence of the `data-theme` attribute, so the CSS
 * `color-scheme: light dark` on :root stays in charge and the page follows the
 * reader's machine with no JavaScript involved. Choosing light or dark writes
 * the attribute, which flips `color-scheme` and with it every `light-dark()`
 * token in globals.css.
 *
 * The choice is this browser's, kept in localStorage. It is a display
 * preference, not a record: nothing here reaches the server, and no page of
 * the record renders differently because of it.
 */

export const THEME_STORAGE_KEY = "chronicle:register";

export const THEME_CHOICES = ["system", "light", "dark"] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type ResolvedTheme = "light" | "dark";

/** Anything unrecognised — an old value, a corrupted store, another origin's
 *  key — falls back to following the system rather than guessing. */
export function normalizeChoice(raw: unknown): ThemeChoice {
  return (THEME_CHOICES as readonly unknown[]).includes(raw)
    ? (raw as ThemeChoice)
    : "system";
}

/** The `data-theme` value for a choice; null for system, which carries none. */
export function themeAttribute(choice: ThemeChoice): ResolvedTheme | null {
  return choice === "system" ? null : choice;
}

/** What the reader actually sees, given their machine's current preference. */
export function resolveTheme(
  choice: ThemeChoice,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (choice === "system") return systemPrefersDark ? "dark" : "light";
  return choice;
}

/** The icon that matches the register on screen. `/favicon.svg` answers the
 *  system preference on its own, so system needs no resolution here. */
export function faviconHref(choice: ThemeChoice): string {
  const attr = themeAttribute(choice);
  return attr ? `/favicon-${attr}.svg` : "/favicon.svg";
}

/** The parts of the DOM this needs, so the logic can be tested without one. */
export interface RegisterTarget {
  documentElement: {
    setAttribute(n: string, v: string): void;
    removeAttribute(n: string): void;
  };
  querySelector(selectors: string): { href: string } | null;
}

/**
 * Put a choice on the page: the attribute the CSS keys off, and the icon that
 * matches it. Idempotent, so it is safe to call on mount as well as on change —
 * and it must be called on mount, because the pre-paint script sets only the
 * attribute. Without it a reader whose stored choice opposes their system keeps
 * the system-following /favicon.svg in the tab on every cold load.
 */
export function applyRegister(
  target: RegisterTarget,
  choice: ThemeChoice,
): void {
  const attr = themeAttribute(choice);
  if (attr) target.documentElement.setAttribute("data-theme", attr);
  else target.documentElement.removeAttribute("data-theme");
  const icon = target.querySelector('link[rel="icon"]');
  if (icon) icon.href = faviconHref(choice);
}

/**
 * Runs in <head>, before first paint, so a reader who chose a register never
 * sees the other one flash. Deliberately tiny and total: a blocked or full
 * localStorage (Safari private browsing throws on read) leaves the attribute
 * off, which is the system default — the page still renders.
 */
export const THEME_INIT_SCRIPT = `try{var c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(c==="light"||c==="dark"){document.documentElement.setAttribute("data-theme",c)}}catch(e){}`;

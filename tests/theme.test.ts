import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyRegister,
  faviconHref,
  normalizeChoice,
  resolveTheme,
  THEME_CHOICES,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  themeAttribute,
} from "@/lib/theme";

const CSS = readFileSync(
  path.join(__dirname, "../src/app/globals.css"),
  "utf8",
);

describe("register choice", () => {
  it("keeps the three real choices", () => {
    for (const choice of THEME_CHOICES) {
      expect(normalizeChoice(choice)).toBe(choice);
    }
  });

  it("falls back to following the system for anything else", () => {
    for (const raw of [null, undefined, "", "DARK", "sepia", 3, {}]) {
      expect(normalizeChoice(raw)).toBe("system");
    }
  });

  it("carries no attribute for system, so the CSS default stays in charge", () => {
    expect(themeAttribute("system")).toBeNull();
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
  });

  it("resolves what the reader sees", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    // An explicit choice overrides the machine in both directions.
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("points the icon at the register on screen", () => {
    expect(faviconHref("system")).toBe("/favicon.svg");
    expect(faviconHref("light")).toBe("/favicon-light.svg");
    expect(faviconHref("dark")).toBe("/favicon-dark.svg");
  });
});

/** Run the head script against a stubbed browser; returns the data-theme it set. */
function runInit(storage: { getItem: (key: string) => string | null }): {
  attribute: string | null;
  keyRead: string | null;
} {
  let keyRead: string | null = null;
  let attribute: string | null = null;
  const localStorage = {
    getItem(key: string) {
      keyRead = key;
      return storage.getItem(key);
    },
  };
  const document = {
    documentElement: {
      setAttribute(name: string, value: string) {
        if (name === "data-theme") attribute = value;
      },
    },
  };
  new Function("localStorage", "document", THEME_INIT_SCRIPT)(
    localStorage,
    document,
  );
  return { attribute, keyRead };
}

describe("pre-paint init script", () => {
  it("reads the one storage key the control writes", () => {
    expect(runInit({ getItem: () => null }).keyRead).toBe(THEME_STORAGE_KEY);
  });

  it("applies a stored register before first paint", () => {
    expect(runInit({ getItem: () => "dark" }).attribute).toBe("dark");
    expect(runInit({ getItem: () => "light" }).attribute).toBe("light");
  });

  it("leaves the attribute off for system and for junk", () => {
    for (const stored of [null, "system", "sepia", "DARK"]) {
      expect(runInit({ getItem: () => stored }).attribute).toBeNull();
    }
  });

  it("survives storage that throws (Safari private browsing)", () => {
    expect(() =>
      runInit({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).not.toThrow();
  });
});

/** A document stub with only what applyRegister touches. */
function stubTarget(iconHref = "/favicon.svg") {
  const attrs = new Map<string, string>();
  const icon = { href: iconHref };
  return {
    attrs,
    icon,
    documentElement: {
      setAttribute: (n: string, v: string) => void attrs.set(n, v),
      removeAttribute: (n: string) => void attrs.delete(n),
    },
    querySelector: (sel: string) => (sel === 'link[rel="icon"]' ? icon : null),
  };
}

describe("applying a register to the page", () => {
  it("puts an explicit choice on the attribute and the icon", () => {
    for (const choice of ["light", "dark"] as const) {
      const t = stubTarget();
      applyRegister(t, choice);
      expect(t.attrs.get("data-theme")).toBe(choice);
      expect(t.icon.href).toBe(`/favicon-${choice}.svg`);
    }
  });

  it("restores the icon on a cold load, which the head script cannot do", () => {
    // The pre-paint script sets data-theme only. Mounting must finish the job,
    // or a reader whose choice opposes their system keeps the system-following
    // favicon.svg in the tab on every fresh load.
    const t = stubTarget();
    t.documentElement.setAttribute("data-theme", "dark"); // as the head script left it
    applyRegister(t, "dark");
    expect(t.icon.href).toBe("/favicon-dark.svg");
  });

  it("clears the attribute and returns the system icon for system", () => {
    const t = stubTarget("/favicon-dark.svg");
    t.documentElement.setAttribute("data-theme", "dark");
    applyRegister(t, "system");
    expect(t.attrs.has("data-theme")).toBe(false);
    expect(t.icon.href).toBe("/favicon.svg");
  });

  it("is idempotent, so mount and change can both call it", () => {
    const t = stubTarget();
    applyRegister(t, "light");
    const after = { attr: t.attrs.get("data-theme"), href: t.icon.href };
    applyRegister(t, "light");
    expect({ attr: t.attrs.get("data-theme"), href: t.icon.href }).toEqual(
      after,
    );
  });

  it("does not throw when the page has no icon link", () => {
    const t = { ...stubTarget(), querySelector: () => null };
    expect(() => applyRegister(t, "dark")).not.toThrow();
  });
});

describe("the two registers cannot drift", () => {
  // Anchored to the real end of the @theme block, not to the first blank-line
  // brace, so nothing after it is silently outside the scan.
  const themeStart = CSS.indexOf("@theme {");
  const themeBlock = CSS.slice(themeStart, CSS.indexOf("\n}", themeStart));

  // Values may wrap across lines; match to the semicolon, not to end of line.
  const declarations = (text: string) => [
    ...text.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g),
  ];

  it("writes every colour token once, as light-dark()", () => {
    const tokens = declarations(themeBlock);
    // Pinned, not a floor: a token that stops matching must fail loudly rather
    // than quietly leaving the light-dark check.
    expect(tokens.length).toBe(23);
    for (const [, name, value] of tokens) {
      expect(
        value.replace(/\s+/g, " ").trim(),
        `${name} must be light-dark(...)`,
      ).toMatch(/^light-dark\( ?#[0-9A-Fa-f]{6}, ?#[0-9A-Fa-f]{6} ?\)$/);
    }
  });

  it("declares each colour token exactly once in the whole file", () => {
    // Scanning only @theme would let a redeclaration under
    // :root[data-theme="dark"] or inside @layer reintroduce the second palette
    // this replaced, with every other assertion still passing.
    const seen = new Map<string, number>();
    for (const [, name] of declarations(CSS)) {
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    const repeated = [...seen].filter(([, n]) => n > 1);
    expect(
      repeated,
      `redeclared: ${repeated.map(([n]) => n).join(", ")}`,
    ).toEqual([]);
  });

  it("has no second palette hiding in a media query", () => {
    // A prefers-color-scheme block here would be a register the control cannot
    // reach — the bug this replaced.
    expect(CSS).not.toContain("prefers-color-scheme");
  });

  it("has no Tailwind dark: variants, which compile to the same trap", () => {
    // Tailwind v4's dark: defaults to the media strategy, so a single dark:
    // utility would emit a prefers-color-scheme block into the built CSS that
    // the control cannot flip — invisible to the assertion above, which only
    // reads the source stylesheet.
    const src = path.join(__dirname, "../src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    const offenders = walk(src)
      .filter((f) => /\.(tsx?|css)$/.test(f))
      .filter((f) => /\bdark:[a-z[-]/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(src, f));
    expect(offenders, `dark: variants in ${offenders.join(", ")}`).toEqual([]);
  });

  it("binds the three states to color-scheme", () => {
    expect(CSS).toMatch(/:root\s*\{\s*color-scheme:\s*light dark;/);
    expect(CSS).toMatch(
      /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/,
    );
    expect(CSS).toMatch(
      /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/,
    );
  });
});

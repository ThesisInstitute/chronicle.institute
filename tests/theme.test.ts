import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
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

describe("the two registers cannot drift", () => {
  const themeBlock = CSS.slice(CSS.indexOf("@theme {"), CSS.indexOf("\n}\n"));

  it("writes every colour token once, as light-dark()", () => {
    const tokens = [...themeBlock.matchAll(/^\s*(--color-[\w-]+):\s*(.+);$/gm)];
    expect(tokens.length).toBeGreaterThan(20);
    const seen = new Set<string>();
    for (const [, name, value] of tokens) {
      expect(value, `${name} must be light-dark(...)`).toMatch(
        /^light-dark\(#[0-9A-Fa-f]{6},\s*#[0-9A-Fa-f]{6}\)$/,
      );
      expect(seen.has(name), `${name} declared twice`).toBe(false);
      seen.add(name);
    }
  });

  it("has no second palette hiding in a media query", () => {
    // A prefers-color-scheme block here would be a register the control cannot
    // reach — the bug this replaced.
    expect(CSS).not.toContain("prefers-color-scheme");
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

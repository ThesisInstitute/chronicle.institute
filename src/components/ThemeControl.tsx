"use client";

import { useEffect, useState } from "react";
import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import {
  faviconHref,
  normalizeChoice,
  THEME_STORAGE_KEY,
  themeAttribute,
  type ThemeChoice,
} from "@/lib/theme";

const OPTIONS: {
  value: ThemeChoice;
  label: string;
  title: string;
  Icon: typeof IconSun;
}[] = [
  {
    value: "system",
    label: "Follow the system register",
    title: "System",
    Icon: IconDeviceDesktop,
  },
  { value: "light", label: "Light register", title: "Light", Icon: IconSun },
  { value: "dark", label: "Dark register", title: "Dark", Icon: IconMoon },
];

function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  const attr = themeAttribute(choice);
  if (attr) root.setAttribute("data-theme", attr);
  else root.removeAttribute("data-theme");
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) icon.href = faviconHref(choice);
}

export function ThemeControl() {
  // The server cannot know the reader's choice, so the first paint of the
  // control is unmarked; the head script has already inked the page itself.
  const [choice, setChoice] = useState<ThemeChoice | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      /* storage denied — follow the system */
    }
    setChoice(normalizeChoice(stored));
  }, []);

  // Another tab of the record is the same reader; keep the two in step.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = normalizeChoice(event.newValue);
      setChoice(next);
      applyChoice(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const choose = (next: ThemeChoice) => {
    setChoice(next);
    applyChoice(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* the register still changes for this page view */
    }
  };

  return (
    <div
      role="group"
      aria-label="Colour register"
      className="flex items-center border border-border-soft"
    >
      {OPTIONS.map(({ value, label, title, Icon }, i) => {
        const selected = choice === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => choose(value)}
            aria-pressed={choice === null ? undefined : selected}
            title={title}
            className={`flex h-7 w-8 items-center justify-center ${
              i > 0 ? "border-l border-border-soft" : ""
            } ${
              selected
                ? "bg-mist-100 text-text-primary"
                : "text-text-tertiary hover:text-text-primary"
            }`}
          >
            <Icon size={15} stroke={1.5} aria-hidden />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

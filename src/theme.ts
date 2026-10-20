// Two colour themes over the same layout: "dark" (default) and "light".
// The active theme is a `data-theme` attribute on <html>; all colours live in CSS
// custom properties (styles.css) and the canvas chart reads the same tokens.

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
const THEMES: Theme[] = ["dark", "light"];

const KEY = "byintent.theme.v1";

/** First visit lands on dark; afterwards whatever the user last picked. */
export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return THEMES.includes(t as Theme) ? (t as Theme) : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* private mode */
    }
  }, [theme]);
  const set = useCallback((t: Theme) => setTheme(t), []);
  return [theme, set];
}

/** Read a CSS custom property from <html> (trimmed). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

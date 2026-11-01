/**
 * Theme state for the popup.
 *
 * Dark is the default and `popup.html` ships `class="dark"` on <html>, so the common
 * path paints dark with no flash. Light is the opt-in half, persisted in
 * chrome.storage.local — the extension's own settings store, never localStorage.
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "theme";

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export async function getTheme(): Promise<Theme> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] === "light" ? "light" : "dark";
}

export async function setTheme(theme: Theme): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: theme });
}

/** Reads the stored theme on mount, applies it, and returns a toggle. */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    getTheme().then((stored) => {
      setThemeState(stored);
      applyTheme(stored);
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      applyTheme(next);
      void setTheme(next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}

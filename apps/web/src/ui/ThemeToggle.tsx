import { useSyncExternalStore } from "react";
import { currentTheme, setTheme, subscribeTheme } from "./theme.ts";

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next);
      }}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          <circle cx="9" cy="9" r="3.25" />
          <path d="M9 1.75v1.5M9 14.75v1.5M1.75 9h1.5M14.75 9h1.5M3.9 3.9l1.06 1.06M13.04 13.04l1.06 1.06M3.9 14.1l1.06-1.06M13.04 4.96l1.06-1.06" />
        </svg>
      ) : (
        <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          <path d="M15.25 10.6A6.5 6.5 0 0 1 7.4 2.75a6.5 6.5 0 1 0 7.85 7.85Z" />
        </svg>
      )}
    </button>
  );
}

// The colour theme: the system setting until the holder picks one, then their pick, kept per
// browser. index.html applies a saved pick before first paint so the page never flashes.

export type Theme = "light" | "dark";

const KEY = "vayle-theme";
const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function saved(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

let choice: Theme | null = saved();

export function currentTheme(): Theme {
  return choice ?? (media.matches ? "dark" : "light");
}

export function subscribeTheme(onChange: () => void): () => void {
  listeners.add(onChange);
  media.addEventListener("change", onChange);
  return () => {
    listeners.delete(onChange);
    media.removeEventListener("change", onChange);
  };
}

export function setTheme(next: Theme): void {
  choice = next;
  document.documentElement.dataset["theme"] = next;
  try {
    localStorage.setItem(KEY, next);
  } catch (error) {
    console.info("The theme applies to this visit only; this browser won't store it.", error);
  }
  for (const listener of listeners) listener();
}

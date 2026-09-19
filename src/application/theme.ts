import type { ReaderPreferences } from "../types/generated";

export function applyTheme(settings: ReaderPreferences) {
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const render = () => {
    const isDark = settings.theme === "dark" || (settings.theme === "system" && media.matches);
    root.classList.remove(
      "dark",
      "theme-warm-dark",
      "theme-oled",
      "theme-warm-tea",
      "theme-bone-white",
      "theme-xuan-paper",
      "theme-jade-green",
    );
    // Always attach the user's selected paper tone identity
    root.classList.add(`theme-${settings.paperTone || "warm-tea"}`);
    if (isDark) {
      root.classList.add("dark", settings.oledBlack ? "theme-oled" : "theme-warm-dark");
    }
  };
  render();
  media.addEventListener("change", render);
  return () => media.removeEventListener("change", render);
}

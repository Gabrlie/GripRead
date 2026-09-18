import type { ReaderPreferences } from "../types/generated";
export function applyTheme(settings: ReaderPreferences) {
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const render = () => {
    const dark = settings.theme === "dark" || (settings.theme === "system" && media.matches);
    root.classList.remove(
      "dark",
      "theme-warm-dark",
      "theme-oled",
      "theme-warm-tea",
      "theme-bone-white",
      "theme-xuan-paper",
      "theme-jade-green",
    );
    if (dark) root.classList.add("dark", settings.oledBlack ? "theme-oled" : "theme-warm-dark");
    else root.classList.add(`theme-${settings.paperTone}`);
  };
  render();
  media.addEventListener("change", render);
  return () => media.removeEventListener("change", render);
}

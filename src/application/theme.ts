import type { ReaderPreferences } from "../types/generated";
import { stylePalette } from "./theme-colors";

/** Variables a custom 界面样式 set on the root, removed when it is left. */
let customVariables: string[] = [];

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
      "theme-custom",
    );
    for (const name of customVariables) root.style.removeProperty(name);
    customVariables = [];
    const custom = settings.customStyle
      ? settings.customStyles?.find((style) => style.id === settings.customStyle)
      : undefined;
    // The paper tone's class stays as the base a custom style overrides.
    root.classList.add(`theme-${settings.paperTone || "warm-tea"}`);
    if (custom) root.classList.add("theme-custom");
    if (isDark) {
      root.classList.add("dark", settings.oledBlack ? "theme-oled" : "theme-warm-dark");
    }
    if (custom) {
      const palette = stylePalette(custom, isDark, isDark && settings.oledBlack);
      for (const [name, value] of Object.entries(palette)) {
        root.style.setProperty(name, value);
        customVariables.push(name);
      }
    }
  };
  render();
  media.addEventListener("change", render);
  return () => media.removeEventListener("change", render);
}

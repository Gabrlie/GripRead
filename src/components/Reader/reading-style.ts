import { useEffect, useState, type CSSProperties } from "react";
import type { ReaderPreferences, ReadingStyle, StylePreset } from "../../types/generated";
import { DEFAULT_READING_STYLE } from "../../types/generated";

const SERIF = '"Literata Variable", "Noto Serif SC Variable", serif';
const SANS = "system-ui, sans-serif";

/** Night follows the app theme, as Legado's 夜间 follows its theme mode. */
export function useNight(preferences: ReaderPreferences | null): boolean {
  const query = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const [systemDark, setSystemDark] = useState(query);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return preferences?.theme === "dark" || (preferences?.theme === "system" && systemDark);
}

export function currentPreset(style: ReadingStyle): StylePreset {
  return style.presets[style.selected] ?? style.presets[0] ?? DEFAULT_READING_STYLE.presets[0];
}

export interface ReadingAppearance {
  /** Colours and paragraph variables for the reader root. */
  root: CSSProperties;
  /** Typography shared by pages, the measurer, and overlays. */
  text: CSSProperties;
  /** Theme colour overrides for the reading menu when it follows the page. */
  menu: CSSProperties;
  /** Every value that changes pagination, for reflow. */
  signature: string;
}

/**
 * The reader's look from Legado-style preferences: the selected preset's day
 * or night colours, body typography, paragraph spacing, first-line indent,
 * and chapter title styling. `customFamily` is a loaded managed font.
 */
export function readingAppearance(
  preferences: ReaderPreferences | null,
  night: boolean,
  customFamily: string | null,
  backgroundUrl: string | null = null,
): ReadingAppearance {
  const style = preferences?.style ?? DEFAULT_READING_STYLE;
  const preset = currentPreset(style);
  const fontSize = preferences?.fontSize ?? 18;
  const lineHeight = preferences?.lineHeight ?? 1.8;
  const family = customFamily
    ? `"${customFamily}", ${SERIF}`
    : preferences?.fontFamily === "sans"
      ? SANS
      : SERIF;
  const root = {
    "--reader-bg": night ? preset.nightBackground : preset.background,
    "--reader-fg": night ? preset.nightText : preset.text,
    "--reader-indent": `${style.indent}em`,
    "--reader-paragraph-gap": `${style.paragraphSpacing}em`,
    "--reader-title-scale": String(style.titleScale),
    "--reader-title-align": style.titleMode === "center" ? "center" : "left",
    "--reader-margin-left": `${style.margins.left}px`,
    "--reader-margin-right": `${style.margins.right}px`,
    "--reader-bg-image": backgroundUrl ? `url("${backgroundUrl}")` : "none",
  } as CSSProperties;
  const background = night ? preset.nightBackground : preset.background;
  const foreground = night ? preset.nightText : preset.text;
  const menu = style.menuFollowsPage ? menuColours(background, foreground) : {};
  const text: CSSProperties = {
    fontSize: `${fontSize}px`,
    lineHeight,
    fontFamily: family,
    letterSpacing: `${style.letterSpacing}em`,
    fontWeight: style.fontWeight,
  };
  const signature = [
    fontSize,
    lineHeight,
    family,
    style.letterSpacing,
    style.fontWeight,
    style.indent,
    style.paragraphSpacing,
    style.titleMode,
    style.titleScale,
    style.margins.top,
    style.margins.bottom,
    style.margins.left,
    style.margins.right,
    style.header.visible,
    style.footer.visible,
    JSON.stringify([style.headerMargins, style.footerMargins, style.headerLine, style.footerLine]),
  ].join("|");
  return { root, text, menu, signature };
}

function rgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "").slice(0, 6);
  const number = Number.parseInt(value.padEnd(6, "0"), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

/**
 * Legado's 菜单跟随背景: the reading menu takes the page colours. The theme's
 * RGB tokens are redefined inside the menu, with containers mixed from the
 * page and text colours.
 */
function menuColours(background: string, foreground: string): CSSProperties {
  const page = rgb(background);
  const ink = rgb(foreground);
  const mix = (amount: number) =>
    page.map((value, index) => Math.round(value + (ink[index] - value) * amount)).join(" ");
  return {
    "--color-surface-rgb": page.join(" "),
    "--color-on-surface-rgb": ink.join(" "),
    "--color-on-surface-variant-rgb": mix(0.75),
    "--color-secondary-rgb": mix(0.7),
    "--color-surface-container-low-rgb": mix(0.05),
    "--color-surface-container-rgb": mix(0.09),
    "--color-surface-container-high-rgb": mix(0.13),
    "--color-surface-variant-rgb": mix(0.18),
    "--color-outline-variant-rgb": mix(0.25),
  } as CSSProperties;
}

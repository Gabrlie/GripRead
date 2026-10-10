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
  } as CSSProperties;
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
  return { root, text, signature };
}

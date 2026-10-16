import type { InterfaceStyle } from "../types/generated";

/**
 * A custom 界面样式's colours: the theme's CSS variables (`--color-*-rgb`,
 * styles.css) derived from its main colour for day and night. The page,
 * text, and secondary colours a reader set by hand are used by day as
 * given; night always derives its own from the main colour, and derived
 * text keeps a readable contrast with its page.
 */

type Rgb = [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

export function parseHex(hex: string | null | undefined): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex?.trim() ?? "");
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/** `a` moved toward `b` by `amount` (0–1). */
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return a.map((part, index) => Math.round(part + (b[index] - part) * amount)) as Rgb;
}

function luminance(colour: Rgb): number {
  const [r, g, b] = colour.map((part) => {
    const value = part / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colours (1–21). */
export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** `colour` moved toward black or white, whichever reads on `page`, until it reaches `ratio`. */
function readable(colour: Rgb, page: Rgb, ratio: number): Rgb {
  const toward = luminance(page) > 0.4 ? BLACK : WHITE;
  let result = colour;
  for (let step = 0; step < 20 && contrast(result, page) < ratio; step++)
    result = mix(result, toward, 0.12);
  return result;
}

const rgb = (colour: Rgb) => colour.join(" ");

/** The theme variables for `style`, day or night; `oled` leaves the black surfaces alone. */
export function stylePalette(
  style: InterfaceStyle,
  dark: boolean,
  oled = false,
): Record<string, string> {
  const main = parseHex(style.primary) ?? [146, 84, 41];
  let surface: Rgb;
  let text: Rgb;
  let primary: Rgb;
  let secondary: Rgb | null;
  if (dark) {
    surface = mix(main, BLACK, 0.86);
    text = readable(mix(main, WHITE, 0.86), surface, 7);
    primary = readable(mix(main, WHITE, 0.3), surface, 3);
    secondary = null;
  } else {
    surface = parseHex(style.paper) ?? mix(main, WHITE, 0.93);
    text = parseHex(style.text) ?? readable(mix(main, BLACK, 0.82), surface, 7);
    primary = readable(main, surface, 3);
    secondary = parseHex(style.secondary);
  }
  const step = (amount: number) => mix(surface, text, amount);
  const palette: Record<string, string> = {
    "--color-on-surface-rgb": rgb(text),
    "--color-on-surface-variant-rgb": rgb(mix(text, surface, 0.25)),
    "--color-secondary-rgb": rgb(secondary ?? readable(mix(text, surface, 0.42), surface, 4.5)),
    "--color-on-secondary-container-rgb": rgb(mix(text, surface, 0.15)),
    "--color-outline-rgb": rgb(mix(text, surface, 0.5)),
    "--color-outline-variant-rgb": rgb(mix(text, surface, 0.78)),
    "--color-primary-rgb": rgb(primary),
    "--color-primary-fixed-rgb": rgb(mix(primary, surface, dark ? 0.7 : 0.82)),
  };
  if (!(dark && oled)) {
    Object.assign(palette, {
      "--color-surface-rgb": rgb(surface),
      "--color-background-rgb": rgb(surface),
      "--color-surface-container-lowest-rgb": rgb(
        dark ? mix(surface, BLACK, 0.3) : mix(surface, WHITE, 0.6),
      ),
      "--color-surface-container-low-rgb": rgb(step(0.025)),
      "--color-surface-container-rgb": rgb(step(0.055)),
      "--color-surface-container-high-rgb": rgb(step(0.08)),
      "--color-surface-container-highest-rgb": rgb(step(0.11)),
      "--color-surface-variant-rgb": rgb(step(0.09)),
      "--color-secondary-container-rgb": rgb(mix(surface, primary, 0.1)),
    });
  }
  return palette;
}

/** Swatch colours for a style: page, a darker swatch, and the main colour. */
export function styleSwatch(style: InterfaceStyle, dark: boolean): [string, string, string] {
  const palette = stylePalette(style, dark);
  const colour = (name: string) => toHex(palette[name].split(" ").map(Number) as unknown as Rgb);
  return [
    colour("--color-surface-rgb"),
    colour("--color-surface-container-highest-rgb"),
    colour("--color-primary-rgb"),
  ];
}

import type { CSSProperties } from "react";
import { styleSwatch } from "../../application/theme-colors";
import { t } from "../../i18n";
import type { InterfaceStyle, PaperTone, ReaderPreferences } from "../../types/generated";
import { Icon } from "../ui/Icon";

/** The app's paper tones: page, swatch, and accent colours, light then dark. */
export const TONES: {
  id: PaperTone;
  light: [string, string, string];
  dark: [string, string, string];
}[] = [
  {
    id: "warm-tea",
    light: ["#fbf8f1", "#eee5d8", "#925429"],
    dark: ["#25221e", "#342e27", "#d49960"],
  },
  {
    id: "bone-white",
    light: ["#faf8f5", "#eae6df", "#2a3b4c"],
    dark: ["#1f2124", "#2f333a", "#96aec6"],
  },
  {
    id: "xuan-paper",
    light: ["#f4ede1", "#e6d8c2", "#a43d24"],
    dark: ["#252019", "#383025", "#cc745a"],
  },
  {
    id: "jade-green",
    light: ["#edf1eb", "#d5e0d3", "#225e41"],
    dark: ["#1b231d", "#28352c", "#6ab38a"],
  },
];

/** At most this many 界面样式 show in 外观; the others wait in 更多外观设置. */
export const PINNED_MAX = 4;

/** A 界面样式 to choose: a built-in paper tone or one the reader made. */
export interface StyleChoice {
  id: string;
  name: string;
  /** The colours a reader set: a custom style, or a built-in tone's override. */
  custom?: InterfaceStyle;
  /** A built-in paper tone (possibly overridden). */
  tone?: boolean;
  light: [string, string, string];
  dark: [string, string, string];
}

export function styleChoices(preferences: ReaderPreferences): StyleChoice[] {
  const styles = preferences.customStyles ?? [];
  const toneIds = new Set<string>(TONES.map((tone) => tone.id));
  return [
    ...TONES.map((tone) => {
      // A built-in tone edited by the reader keeps its row with their colours.
      const override = styles.find((style) => style.id === tone.id);
      return {
        id: tone.id,
        name: t(`settings.tone.${tone.id}`),
        tone: true,
        custom: override,
        light: override ? styleSwatch(override, false) : tone.light,
        dark: override ? styleSwatch(override, true) : tone.dark,
      };
    }),
    ...styles
      .filter((style) => !toneIds.has(style.id))
      .map((style) => ({
        id: style.id,
        name: style.name,
        custom: style,
        light: styleSwatch(style, false),
        dark: styleSwatch(style, true),
      })),
  ];
}

/** The colours the editor starts from: the style's own, or a tone's as built. */
export function editable(choice: StyleChoice): InterfaceStyle {
  if (choice.custom) return choice.custom;
  const tone = TONES.find((item) => item.id === choice.id);
  return {
    id: choice.id,
    name: choice.name,
    primary: tone?.light[2] ?? "#925429",
    paper: tone?.light[0] ?? null,
    text: null,
    secondary: null,
  };
}

/** The styles shown in 外观: the pinned ones that still exist, else the four tones. */
export function pinnedChoices(preferences: ReaderPreferences): StyleChoice[] {
  const all = styleChoices(preferences);
  const pinned = (preferences.pinnedStyles ?? [])
    .map((id) => all.find((choice) => choice.id === id))
    .filter((choice): choice is StyleChoice => Boolean(choice));
  return pinned.length ? pinned.slice(0, PINNED_MAX) : all.slice(0, PINNED_MAX);
}

export function chosenStyle(preferences: ReaderPreferences): string {
  const custom = preferences.customStyle;
  return custom && preferences.customStyles?.some((style) => style.id === custom)
    ? custom
    : preferences.paperTone;
}

/** The preferences change that makes `choice` the 界面样式 in use. */
export function choose(choice: StyleChoice): Partial<ReaderPreferences> {
  if (choice.tone)
    return {
      paperTone: choice.id as PaperTone,
      customStyle: choice.custom ? choice.id : undefined,
    };
  return { customStyle: choice.id };
}

/** CSS variables for a style's swatch; the `dark:` classes pick the night set. */
function swatchStyle(choice: StyleChoice) {
  const [paper, swatch, accent] = choice.light;
  const [nightPaper, nightSwatch, nightAccent] = choice.dark;
  return {
    "--tone-paper": paper,
    "--tone-swatch": swatch,
    "--tone-accent": accent,
    "--tone-paper-dark": nightPaper,
    "--tone-swatch-dark": nightSwatch,
    "--tone-accent-dark": nightAccent,
  } as CSSProperties;
}

/** One 界面样式 to choose, drawn in its own colours. */
export function StyleSwatch({
  choice,
  selected,
  onChoose,
}: {
  choice: StyleChoice;
  selected: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onChoose}
      style={swatchStyle(choice)}
      className={`flex flex-col items-center gap-1 rounded-xl p-1.5 min-w-0 border border-black/5 dark:border-white/10 bg-[var(--tone-paper)] dark:bg-[var(--tone-paper-dark)] text-[var(--tone-accent)] dark:text-[var(--tone-accent-dark)] ${selected ? "ring-2 ring-[var(--tone-accent)] dark:ring-[var(--tone-accent-dark)]" : ""}`}
    >
      <span className="w-full h-7 rounded-lg flex items-center justify-center bg-[var(--tone-swatch)] dark:bg-[var(--tone-swatch-dark)]">
        {selected && <Icon name="check" size={15} />}
      </span>
      <span className="text-[11px] truncate max-w-full">{choice.name}</span>
    </button>
  );
}

import { useState } from "react";
import { t, type MessageKey } from "../../../i18n";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";

/** The template naming Legado's own `第N章(n)` titles (the core's `LEGADO_TITLES`). */
export const LEGADO_TITLES = "{legado}";

/** The presets: Legado's own, then templates. */
const PRESETS: [string, MessageKey][] = [
  [LEGADO_TITLES, "contents.untitledLegado"],
  ["第{n}节", "contents.untitledSection"],
  ["#{n}", "contents.untitledNumber"],
  ["{text}", "contents.untitledText"],
];

const FOLLOW = "follow";
const CUSTOM = "custom";

/** Rule-less pieces' titles and size; unset fields are Legado's (or, for a book, the default's). */
export interface UntitledStyle {
  title?: string;
  chunkKb?: number;
}

/** A short name for a style, as listed in the dialog. */
export function untitledLabel(style: UntitledStyle): string {
  const preset = PRESETS.find(([template]) => template === (style.title ?? LEGADO_TITLES));
  const title = preset ? t(preset[1]) : (style.title ?? "");
  return style.chunkKb && style.chunkKb !== 10
    ? t("contents.untitledWithSize", { title, kb: style.chunkKb })
    : title;
}

/**
 * 未命中规则时的标题: what the pieces are called when no rule finds a TXT's
 * chapters and it is cut by size, and how big the pieces are. For a book,
 * `fallback` is the app's default, which the book follows until it sets
 * its own; without it the dialog edits that default.
 */
export function UntitledTitleDialog({
  style,
  fallback,
  busy,
  onSave,
  onClose,
}: {
  style: UntitledStyle;
  fallback?: UntitledStyle;
  busy: boolean;
  onSave: (style: UntitledStyle) => void;
  onClose: () => void;
}) {
  const own = style.title !== undefined || style.chunkKb !== undefined;
  const current = style.title ?? LEGADO_TITLES;
  const preset = PRESETS.some(([template]) => template === current);
  const [choice, setChoice] = useState(fallback && !own ? FOLLOW : preset ? current : CUSTOM);
  const [template, setTemplate] = useState(preset ? "第{n}节 {text}" : current);
  const [size, setSize] = useState(String(style.chunkKb ?? fallback?.chunkKb ?? 10));
  const kb = Math.min(200, Math.max(2, Math.round(Number(size) || 10)));
  const options: [string, string][] = [
    ...(fallback
      ? [
          [FOLLOW, t("contents.untitledFollow", { style: untitledLabel(fallback) })] as [
            string,
            string,
          ],
        ]
      : []),
    ...PRESETS.map(([value, label]) => [value, t(label)] as [string, string]),
    [CUSTOM, t("contents.untitledCustom")],
  ];
  const save = () => {
    if (choice === FOLLOW) return onSave({});
    const title = choice === CUSTOM ? template.trim() || LEGADO_TITLES : choice;
    // A book keeps its choice even where it matches Legado's; the default
    // leaves Legado's unset.
    if (fallback) return onSave({ title, chunkKb: kb });
    onSave({
      title: title === LEGADO_TITLES ? undefined : title,
      chunkKb: kb === 10 ? undefined : kb,
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {fallback ? t("contents.untitled") : t("contents.untitledDefault")}
          </DialogTitle>
          <DialogDescription>{t("contents.untitledNote")}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={t("contents.untitled")} className="space-y-1">
          {options.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm py-1 min-w-0">
              <input
                type="radio"
                name="untitled"
                checked={choice === value}
                onChange={() => setChoice(value)}
              />
              <span className="truncate">{label}</span>
            </label>
          ))}
        </div>
        {choice === CUSTOM && (
          <label className="block space-y-1 text-xs text-secondary">
            {t("contents.untitledTemplate")}
            <Input
              aria-label={t("contents.untitledTemplate")}
              value={template}
              maxLength={64}
              onChange={(event) => setTemplate(event.target.value)}
            />
            <span className="block text-[11px]">{t("contents.untitledHelp")}</span>
          </label>
        )}
        {choice !== FOLLOW && (
          <label className="flex items-center justify-between gap-3 text-sm">
            {t("contents.chunkKb")}
            <Input
              aria-label={t("contents.chunkKb")}
              className="w-20 h-8"
              inputMode="numeric"
              value={size}
              onChange={(event) => setSize(event.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={busy} onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from "react";
import type { BookTocSettings } from "../../../types/generated";
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

/** The presets: Legado's own (no template), then templates. */
const PRESETS: [string | null, MessageKey][] = [
  [null, "contents.untitledLegado"],
  ["第{n}节", "contents.untitledSection"],
  ["#{n}", "contents.untitledNumber"],
  ["{text}", "contents.untitledText"],
];

/**
 * 未命中规则时的标题: what the pieces are called when no rule finds a TXT's
 * chapters and it is cut by size, and how big the pieces are.
 */
export function UntitledTitleDialog({
  settings,
  busy,
  onSave,
  onClose,
}: {
  settings: BookTocSettings;
  busy: boolean;
  onSave: (settings: BookTocSettings) => void;
  onClose: () => void;
}) {
  const current = settings.untitledTitle ?? null;
  const preset = PRESETS.some(([template]) => template === current);
  const [choice, setChoice] = useState<string | null | "custom">(preset ? current : "custom");
  const [template, setTemplate] = useState(preset ? "第{n}节 {text}" : (current ?? ""));
  const [size, setSize] = useState(String(settings.chunkKb ?? 10));
  const chosen = choice === "custom" ? template.trim() || null : choice;
  const kb = Math.min(200, Math.max(2, Math.round(Number(size) || 10)));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("contents.untitled")}
          </DialogTitle>
          <DialogDescription>{t("contents.untitledNote")}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={t("contents.untitled")} className="space-y-1">
          {[...PRESETS, ["custom", "contents.untitledCustom"] as [string, MessageKey]].map(
            ([value, label]) => (
              <label key={label} className="flex items-center gap-2 text-sm py-1">
                <input
                  type="radio"
                  name="untitled"
                  checked={choice === value}
                  onChange={() => setChoice(value)}
                />
                {t(label)}
              </label>
            ),
          )}
        </div>
        {choice === "custom" && (
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
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              onSave({
                ...settings,
                untitledTitle: chosen ?? undefined,
                chunkKb: kb === 10 ? undefined : kb,
              })
            }
          >
            {t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

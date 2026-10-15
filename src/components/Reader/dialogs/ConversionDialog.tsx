import type { ChineseConversion } from "../../../types/generated";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Icon } from "../../ui/Icon";
import { t } from "../../../i18n";

const choices = (): [ChineseConversion, string, string][] => [
  ["off", t("reader.conversion.off"), t("reader.conversion.off.note")],
  ["to_simplified", t("reader.conversion.toSimplified"), t("reader.conversion.toSimplified.note")],
  [
    "to_traditional",
    t("reader.conversion.toTraditional"),
    t("reader.conversion.toTraditional.note"),
  ],
];

/** Legado's 简繁转换 choice; changing it regenerates the book's text. */
export function ConversionDialog({
  value,
  onChange,
  onClose,
}: {
  value: ChineseConversion;
  onChange: (value: ChineseConversion) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-xs p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("reader.conversion")}
          </DialogTitle>
          <DialogDescription>{t("reader.conversion.note")}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={t("reader.conversion")} className="space-y-1">
          {choices().map(([choice, label, note]) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={value === choice}
              onClick={() => {
                onChange(choice);
                onClose();
              }}
              className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left ${value === choice ? "bg-secondary-container" : "hover:bg-surface-container"}`}
            >
              <span className="flex-1">
                <span className="block text-sm">{label}</span>
                <span className="block text-[11px] text-secondary">{note}</span>
              </span>
              {value === choice && <Icon name="check" size={16} className="text-primary" />}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

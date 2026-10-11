import type { ChineseConversion } from "../../../types/generated";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Icon } from "../../ui/Icon";

const CHOICES: [ChineseConversion, string, string][] = [
  ["off", "不转换", "按原文显示"],
  ["to_simplified", "繁转简", "繁体字显示为简体"],
  ["to_traditional", "简转繁", "简体字显示为繁体"],
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
          <DialogTitle className="font-title-editorial text-base">简繁转换</DialogTitle>
          <DialogDescription>所有书共用，切换后重新生成文本，阅读位置随之调整。</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="简繁转换" className="space-y-1">
          {CHOICES.map(([choice, label, note]) => (
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

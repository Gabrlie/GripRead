import type { ReaderTool } from "../../../types/generated";
import { DEFAULT_READING_STYLE } from "../../../types/generated";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Icon } from "../../ui/Icon";
import { ALL_READER_TOOLS, MAX_BOTTOM_TOOLS, READER_TOOLS } from "../reader-tools";
import { t } from "../../../i18n";

/**
 * The bottom bar's buttons as a floating dialog from the top bar's 更多
 * menu, so the configuration stays reachable whatever the bar shows.
 */
export function BottomToolsDialog({
  tools,
  onChange,
  onClose,
}: {
  tools: ReaderTool[];
  onChange: (tools: ReaderTool[]) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm max-h-[80dvh] overflow-y-auto p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("reader.bottomTools")}
          </DialogTitle>
          <DialogDescription>{t("tools.note")}</DialogDescription>
        </DialogHeader>
        <BottomToolsEditor tools={tools} onChange={onChange} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The bottom bar's buttons: shown ones in order, with move and remove, then
 * the remaining tools to add.
 */
export function BottomToolsEditor({
  tools,
  onChange,
}: {
  tools: ReaderTool[];
  onChange: (tools: ReaderTool[]) => void;
}) {
  const move = (index: number, step: -1 | 1) => {
    const next = [...tools];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    onChange(next);
  };
  const hidden = ALL_READER_TOOLS.filter((tool) => !tools.includes(tool));
  const full = tools.length >= MAX_BOTTOM_TOOLS;
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-secondary">{t("tools.limit", { max: MAX_BOTTOM_TOOLS })}</p>
      <ul aria-label={t("tools.list")} className="space-y-1">
        {tools.map((tool, index) => (
          <li
            key={tool}
            className="flex items-center gap-2 rounded-lg bg-surface-container px-2 py-1 text-xs"
          >
            <Icon name={READER_TOOLS[tool].icon} size={15} className="text-secondary" />
            <span className="flex-1">{READER_TOOLS[tool].label}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("tools.up", { name: READER_TOOLS[tool].label })}
              className="h-7 w-7 text-secondary"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <Icon name="arrow_upward" size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("tools.down", { name: READER_TOOLS[tool].label })}
              className="h-7 w-7 text-secondary"
              disabled={index === tools.length - 1}
              onClick={() => move(index, 1)}
            >
              <Icon name="arrow_downward" size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("tools.remove", { name: READER_TOOLS[tool].label })}
              className="h-7 w-7 text-secondary"
              disabled={tools.length <= 1}
              onClick={() => onChange(tools.filter((item) => item !== tool))}
            >
              <Icon name="close" size={14} />
            </Button>
          </li>
        ))}
      </ul>
      {hidden.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={t("tools.available")}>
          {hidden.map((tool) => (
            <button
              key={tool}
              type="button"
              disabled={full}
              aria-label={t("tools.add", { name: READER_TOOLS[tool].label })}
              onClick={() => onChange([...tools, tool])}
              className="h-7 px-2.5 rounded-full text-[11px] border border-surface-variant flex items-center gap-1 disabled:opacity-40"
            >
              <Icon name="add" size={12} />
              {READER_TOOLS[tool].label}
            </button>
          ))}
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-[11px]"
        onClick={() => onChange(DEFAULT_READING_STYLE.bottomTools)}
      >
        {t("detail.resetCover")}
      </Button>
    </div>
  );
}

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
          <DialogTitle className="font-title-editorial text-base">底部工具栏</DialogTitle>
          <DialogDescription>选择阅读菜单底部显示的按钮和顺序。</DialogDescription>
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
      <p className="text-[11px] text-secondary">最多 {MAX_BOTTOM_TOOLS} 个，至少保留 1 个。</p>
      <ul aria-label="底部工具栏按钮" className="space-y-1">
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
              aria-label={`上移 ${READER_TOOLS[tool].label}`}
              className="h-7 w-7 text-secondary"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <Icon name="arrow_upward" size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`下移 ${READER_TOOLS[tool].label}`}
              className="h-7 w-7 text-secondary"
              disabled={index === tools.length - 1}
              onClick={() => move(index, 1)}
            >
              <Icon name="arrow_downward" size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`移除 ${READER_TOOLS[tool].label}`}
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
        <div className="flex flex-wrap gap-1.5" aria-label="可添加的按钮">
          {hidden.map((tool) => (
            <button
              key={tool}
              type="button"
              disabled={full}
              aria-label={`添加 ${READER_TOOLS[tool].label}`}
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
        恢复默认
      </Button>
    </div>
  );
}

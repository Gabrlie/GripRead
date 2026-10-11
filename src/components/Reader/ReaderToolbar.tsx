import { useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { Slider } from "../ui/slider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { ReaderPanel } from "./use-reader-panel";
import type { ChineseConversion, ReaderTool } from "../../types/generated";
import { READER_TOOLS } from "./reader-tools";

const hiddenClass = (visible: boolean, hidden: string) =>
  `transition-transform duration-300 motion-reduce:transition-none ${visible ? "translate-y-0" : hidden}`;

interface ReaderTopBarProps {
  visible: boolean;
  title: string;
  /** The current chapter. */
  subtitle: string;
  closing: boolean;
  onBack: () => void;
  onOpenPanel: (panel: ReaderPanel) => void;
  canBookmark: boolean;
  onAddBookmark: () => void;
  onRefreshDirectory: () => void;
  /** Legado's per-book 替换净化 switch. */
  replaceEnabled: boolean;
  onToggleReplace: () => void;
  conversion: ChineseConversion;
  onOpenConversion: () => void;
  /** The bottom bar configuration. */
  onOpenTools: () => void;
  /** The book detail page; the title opens it too. */
  onOpenDetail: () => void;
}

const CONVERSION_LABELS: Record<ChineseConversion, string> = {
  off: "不转换",
  to_simplified: "繁转简",
  to_traditional: "简转繁",
};

/** Legado's read menu title bar: book and chapter, TXT tools, and More. */
export function ReaderTopBar({
  visible,
  title,
  subtitle,
  closing,
  onBack,
  onOpenPanel,
  canBookmark,
  onAddBookmark,
  onRefreshDirectory,
  replaceEnabled,
  onToggleReplace,
  conversion,
  onOpenConversion,
  onOpenTools,
  onOpenDetail,
}: ReaderTopBarProps) {
  const action = (panel: ReaderPanel, label: string, icon: string) => (
    <Button
      aria-label={label}
      title={label}
      variant="ghost"
      size="icon"
      className="h-9 w-9 text-secondary rounded-full"
      onClick={() => onOpenPanel(panel)}
    >
      <Icon name={icon} size={19} />
    </Button>
  );
  return (
    <header
      className={`fixed top-0 left-0 right-0 z-20 bg-surface border-b border-surface-variant/30 pt-safe ${hiddenClass(visible, "-translate-y-full")}`}
      inert={!visible}
    >
      <div className="h-14 px-2 sm:px-4 flex items-center max-w-4xl mx-auto gap-1">
        <Button
          data-testid="reader-close"
          aria-label="返回书架"
          variant="ghost"
          size="icon"
          disabled={closing}
          onClick={onBack}
          className="h-9 w-9 text-secondary rounded-full shrink-0"
        >
          <Icon name="arrow_back" size={20} />
        </Button>
        <button
          type="button"
          aria-label="书籍详情"
          className="flex-1 min-w-0 px-1 text-left rounded-lg"
          onClick={onOpenDetail}
        >
          <h1 className="font-title-editorial truncate text-[15px] font-semibold leading-tight">
            {title}
          </h1>
          <p className="text-[11px] text-secondary truncate leading-tight mt-0.5">{subtitle}</p>
        </button>
        {action("rules", "TXT目录规则", "toc_rule")}
        {action("encoding", "设置编码", "translate")}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="更多"
            className="h-9 w-9 rounded-full flex items-center justify-center text-secondary hover:bg-surface-container/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Icon name="more_vert" size={19} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem disabled={!canBookmark} onClick={onAddBookmark}>
              <Icon name="bookmark_add" size={15} />
              添加书签
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRefreshDirectory}>
              <Icon name="refresh" size={15} />
              更新目录
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenPanel("style")}>
              <Icon name="swap_vert" size={15} />
              翻页动画
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onToggleReplace}>
              <Icon name={replaceEnabled ? "check" : "find_replace"} size={15} />
              替换净化{replaceEnabled ? "：开" : "：关"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenPanel("replace")}>
              <Icon name="find_replace" size={15} />
              替换规则
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenConversion}>
              <Icon name="translate" size={15} />
              简繁转换
              <span className="ml-auto pl-3 text-[11px] text-secondary">
                {CONVERSION_LABELS[conversion]}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenTools}>
              <Icon name="tune" size={15} />
              底部工具栏
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenDetail}>
              <Icon name="info" size={15} />
              书籍详情
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

interface ReaderBottomBarProps {
  visible: boolean;
  previous: { disabled: boolean; onClick: () => void };
  next: { disabled: boolean; onClick: () => void };
  /** Position within the current chapter, 0–100. */
  progress: number;
  progressDisabled: boolean;
  onProgressDraft: () => void;
  onProgressCommit: (percent: number) => void;
  /** The configured tool buttons, in order. */
  tools: readonly ReaderTool[];
  onTool: (tool: ReaderTool) => void;
  night: boolean;
}

/**
 * Legado's bottom menu: previous chapter, in-chapter progress, next chapter,
 * then the tool buttons chosen in 更多设置 (by default search, automatic page
 * turning, read-aloud, contents, 界面, and day/night).
 */
export function ReaderBottomBar({
  visible,
  previous,
  next,
  progress,
  progressDisabled,
  onProgressDraft,
  onProgressCommit,
  tools,
  onTool,
  night,
}: ReaderBottomBarProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const tool = (label: string, icon: string, onClick: () => void) => (
    <Button
      variant="ghost"
      aria-label={label}
      className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1.5 px-2 text-[11px] gap-1 min-w-14"
      onClick={onClick}
    >
      <Icon name={icon} size={20} />
      {label}
    </Button>
  );
  const navClass = "text-xs text-secondary hover:text-on-surface h-8 px-2.5 shrink-0";
  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-20 bg-surface pb-safe border-t border-surface-variant/30 ${hiddenClass(visible, "translate-y-full")}`}
      inert={!visible}
    >
      <div className="max-w-xl mx-auto px-3 sm:px-6 pt-2.5 pb-2 space-y-2">
        <div className="flex items-center gap-2">
          <Button
            data-testid="reader-previous-chapter"
            variant="ghost"
            size="sm"
            className={navClass}
            disabled={previous.disabled}
            onClick={previous.onClick}
          >
            上一章
          </Button>
          <Slider
            data-testid="reader-progress"
            aria-label="章节进度"
            className="flex-1"
            min={0}
            max={100}
            step={1}
            disabled={progressDisabled}
            value={draft ?? progress}
            onValueChange={(value) => {
              onProgressDraft();
              setDraft(Array.isArray(value) ? value[0] : value);
            }}
            onValueCommitted={(value) => {
              setDraft(null);
              onProgressCommit(Array.isArray(value) ? value[0] : value);
            }}
          />
          <Button
            data-testid="reader-next-chapter"
            variant="ghost"
            size="sm"
            className={navClass}
            disabled={next.disabled}
            onClick={next.onClick}
          >
            下一章
          </Button>
        </div>
        <div className="flex items-center justify-around">
          {tools.map((item) => {
            const { label, icon } =
              item === "night" && night
                ? { label: "日间", icon: "light_mode" }
                : READER_TOOLS[item];
            return <span key={item}>{tool(label, icon, () => onTool(item))}</span>;
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Legado's brightness bar beside the reading menu: a vertical slider and a
 * button that returns brightness to the system setting.
 */
export function ReaderBrightnessBar({
  visible,
  value,
  onChange,
}: {
  visible: boolean;
  /** 0–1, or `null` while following the system. */
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const following = value === null;
  return (
    <div
      className={`fixed left-2 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-2 rounded-full bg-surface/95 border border-surface-variant/40 shadow-sm px-1.5 py-2 transition-opacity duration-300 motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      inert={!visible}
    >
      <button
        type="button"
        aria-label="亮度跟随系统"
        aria-pressed={following}
        className={`h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-semibold ${following ? "bg-primary text-on-primary" : "text-secondary hover:bg-surface-container"}`}
        onClick={() => onChange(following ? 0.5 : null)}
      >
        A
      </button>
      <div className="h-40 py-1">
        <Slider
          aria-label="屏幕亮度"
          orientation="vertical"
          min={0}
          max={100}
          step={1}
          value={Math.round((value ?? 0.5) * 100)}
          onValueChange={(next) => onChange((Array.isArray(next) ? next[0] : next) / 100)}
        />
      </div>
      <Icon name="brightness" size={16} className="text-secondary" />
    </div>
  );
}

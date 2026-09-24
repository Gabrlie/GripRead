import { useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { Slider } from "../ui/slider";
import type { ReaderPanel } from "./use-reader-panel";

const hiddenClass = (visible: boolean, hidden: string) =>
  `transition-transform duration-300 motion-reduce:transition-none ${visible ? "translate-y-0" : hidden}`;

interface ReaderTopBarProps {
  visible: boolean;
  title: string;
  subtitle: string;
  closing: boolean;
  onBack: () => void;
  onOpenPanel: (panel: ReaderPanel) => void;
}

export function ReaderTopBar({
  visible,
  title,
  subtitle,
  closing,
  onBack,
  onOpenPanel,
}: ReaderTopBarProps) {
  const action = (panel: ReaderPanel, label: string, icon: string) => (
    <Button
      aria-label={label}
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-secondary rounded-full"
      onClick={() => onOpenPanel(panel)}
    >
      <Icon name={icon} size={18} />
    </Button>
  );
  return (
    <header
      className={`fixed top-0 left-0 right-0 z-20 bg-surface/90 backdrop-blur-xl border-b border-surface-variant/30 pt-safe ${hiddenClass(visible, "-translate-y-full")}`}
      inert={!visible}
    >
      <div className="h-14 px-4 sm:px-6 flex items-center justify-between max-w-4xl mx-auto gap-2">
        <Button
          data-testid="reader-close"
          aria-label="返回书架"
          variant="ghost"
          size="icon"
          disabled={closing}
          onClick={onBack}
          className="h-9 w-9 text-secondary rounded-full"
        >
          <Icon name="arrow_back" size={20} />
        </Button>
        <div className="flex-1 min-w-0 text-center">
          <h1 className="font-title-editorial truncate text-sm font-semibold">{title}</h1>
          <p className="text-[10px] text-secondary mt-0.5 truncate">{subtitle}</p>
        </div>
        <div className="flex items-center gap-0.5">
          {action("directory", "目录规则", "import_contacts")}
          {action("encoding", "编码格式", "tune")}
          {action("more", "更多", "more_horiz")}
        </div>
      </div>
    </header>
  );
}

interface ReaderBottomBarProps {
  visible: boolean;
  /** Labels and disabled states of the paired navigation buttons. */
  previous: { label: string; disabled: boolean; onClick: () => void };
  next: { label: string; disabled: boolean; onClick: () => void };
  progress: number;
  progressLabel: string;
  progressDisabled: boolean;
  onProgressDraft: () => void;
  onProgressCommit: (percent: number) => void;
  onOpenPanel: (panel: ReaderPanel) => void;
}

export function ReaderBottomBar({
  visible,
  previous,
  next,
  progress,
  progressLabel,
  progressDisabled,
  onProgressDraft,
  onProgressCommit,
  onOpenPanel,
}: ReaderBottomBarProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const tool = (panel: ReaderPanel, label: string, text: string, icon: string) => (
    <Button
      variant="ghost"
      aria-label={label}
      className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1 px-3 text-xs gap-1"
      onClick={() => onOpenPanel(panel)}
    >
      <Icon name={icon} size={20} />
      {text}
    </Button>
  );
  const navClass =
    "text-xs text-secondary hover:text-on-surface h-7 px-2 bg-surface-container shrink-0";
  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-20 bg-surface/90 backdrop-blur-xl pb-safe border-t border-surface-variant/30 ${hiddenClass(visible, "translate-y-full")}`}
      inert={!visible}
    >
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-3 space-y-3">
        <div className="flex items-center gap-3">
          <Button
            data-testid="reader-previous"
            variant="ghost"
            size="sm"
            className={navClass}
            disabled={previous.disabled}
            onClick={previous.onClick}
          >
            {previous.label}
          </Button>
          <Slider
            data-testid="reader-progress"
            aria-label={progressLabel}
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
          <span className="text-[11px] text-secondary tabular-nums w-9 text-right">
            {draft ?? progress}%
          </span>
          <Button
            data-testid="reader-next"
            variant="ghost"
            size="sm"
            className={navClass}
            disabled={next.disabled}
            onClick={next.onClick}
          >
            {next.label}
          </Button>
        </div>
        <div className="flex items-center justify-around">
          {tool("search", "搜索正文", "搜索", "search")}
          {tool("automatic", "自动翻页", "自动翻页", "schedule")}
          {tool("contents", "目录", "目录", "list")}
          {tool("settings", "设置", "设置", "format_size")}
        </div>
      </div>
    </div>
  );
}

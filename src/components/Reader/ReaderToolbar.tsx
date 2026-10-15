import { useEffect, useState } from "react";
import { system } from "../../services/system";
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
import { t } from "../../i18n";

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
  /** TXT目录规则 and 设置编码 apply to local TXT books only. */
  txtTools?: boolean;
  /** 换源, for an online book. */
  onChangeSource?: () => void;
  /** 缓存 a chapter range, for an online book. */
  onCache?: () => void;
}

const CONVERSION_LABELS: Record<ChineseConversion, string> = {
  get off() {
    return t("reader.conversion.off");
  },
  get to_simplified() {
    return t("reader.conversion.toSimplified");
  },
  get to_traditional() {
    return t("reader.conversion.toTraditional");
  },
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
  txtTools = true,
  onChangeSource,
  onCache,
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
          aria-label={t("reader.backToShelf")}
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
          aria-label={t("detail.title")}
          className="flex-1 min-w-0 px-1 text-left rounded-lg"
          onClick={onOpenDetail}
        >
          <h1 className="font-title-editorial truncate text-[15px] font-semibold leading-tight">
            {title}
          </h1>
          <p className="text-[11px] text-secondary truncate leading-tight mt-0.5">{subtitle}</p>
        </button>
        {onCache && (
          <Button
            aria-label={t("detail.cache")}
            title={t("detail.cache")}
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-secondary rounded-full"
            onClick={onCache}
          >
            <Icon name="download" size={19} />
          </Button>
        )}
        {onChangeSource && (
          <Button
            aria-label={t("detail.changeSource")}
            title={t("detail.changeSource")}
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-secondary rounded-full"
            onClick={onChangeSource}
          >
            <Icon name="swap_horiz" size={19} />
          </Button>
        )}
        {txtTools && action("rules", t("settings.toc"), "toc_rule")}
        {txtTools && action("encoding", t("reader.setEncoding"), "translate")}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("reader.more")}
            className="h-9 w-9 rounded-full flex items-center justify-center text-secondary hover:bg-surface-container/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Icon name="more_vert" size={19} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem disabled={!canBookmark} onClick={onAddBookmark}>
              <Icon name="bookmark_add" size={15} />
              {t("reader.addBookmark")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRefreshDirectory}>
              <Icon name="refresh" size={15} />
              {t("shelf.menu.update")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenPanel("style")}>
              <Icon name="swap_vert" size={15} />
              {t("style.effect")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onToggleReplace}>
              <Icon name={replaceEnabled ? "check" : "find_replace"} size={15} />
              {t("reader.replaceState", {
                state: replaceEnabled ? t("common.on") : t("common.off"),
              })}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenPanel("replace")}>
              <Icon name="find_replace" size={15} />
              {t("settings.replace")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenConversion}>
              <Icon name="translate" size={15} />
              {t("reader.conversion")}
              <span className="ml-auto pl-3 text-[11px] text-secondary">
                {CONVERSION_LABELS[conversion]}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenTools}>
              <Icon name="tune" size={15} />
              {t("reader.bottomTools")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenDetail}>
              <Icon name="info" size={15} />
              {t("detail.title")}
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
            {t("style.tap.previousChapter")}
          </Button>
          <Slider
            data-testid="reader-progress"
            aria-label={t("style.slot.chapterProgress")}
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
            {t("style.tap.nextChapter")}
          </Button>
        </div>
        <div className="flex items-center justify-around">
          {tools.map((item) => {
            const { label, icon } =
              item === "night" && night
                ? { label: t("reader.day"), icon: "light_mode" }
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
  // While following, the bar shows the system's brightness as it changes.
  const [systemValue, setSystemValue] = useState(() => system.getBrightness() ?? 0.5);
  useEffect(() => {
    if (!following) return;
    setSystemValue(system.getBrightness() ?? 0.5);
    return system.onBrightness(setSystemValue);
  }, [following]);
  const shown = value ?? systemValue;
  return (
    <div
      className={`fixed left-2 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-2 rounded-full bg-surface/95 border border-surface-variant/40 shadow-sm px-1.5 py-2 transition-opacity duration-300 motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      inert={!visible}
    >
      <button
        type="button"
        aria-label={t("reader.brightnessSystem")}
        aria-pressed={following}
        className={`h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-semibold ${following ? "bg-primary text-on-primary" : "text-secondary hover:bg-surface-container"}`}
        onClick={() => onChange(following ? systemValue : null)}
      >
        A
      </button>
      <div className="h-40 py-1">
        <Slider
          aria-label={t("reader.brightness")}
          orientation="vertical"
          min={0}
          max={100}
          step={1}
          value={Math.round(shown * 100)}
          onValueChange={(next) => onChange((Array.isArray(next) ? next[0] : next) / 100)}
        />
      </div>
      <Icon name="brightness" size={16} className="text-secondary" />
    </div>
  );
}

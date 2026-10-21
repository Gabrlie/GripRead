import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWindowedList } from "../../ui/use-windowed-list";
import type { Bookmark, ReaderLocator, TocEntry } from "../../../types/generated";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/Icon";
import { Input } from "../../ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { currentLocale, t } from "../../../i18n";
import { chapterTag } from "../../../application/chapter-tag";
import { LoadFailed } from "../../ui/LoadFailed";
import { useErrorToast } from "../../ui/toast";

interface ContentsPageProps {
  bookTitle: string;
  toc: TocEntry[];
  /** Name of the rule that produced the directory. */
  ruleName: string;
  splitLongChapters: boolean;
  /** Start offset of the visible page, used to find the current chapter. */
  position: number;
  loading: boolean;
  error: string | null;
  busy: boolean;
  bookmarks: Bookmark[];
  contentVersion: string | undefined;
  onReload: () => void;
  onSeek: (locator: ReaderLocator) => void;
  onOpenBookmark: (bookmark: Bookmark) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onEditBookmark: (bookmark: Bookmark) => void;
  onOpenRules: () => void;
  onToggleSplit: () => void;
  onClose: () => void;
  /** For a book read chapter by chapter: the chapter resource being read. */
  resourceId?: string;
  /**
   * What the More menu offers: a TXT its rule, 拆分超长章节, and the titles
   * of pieces no rule names; an online book 章内分章 (with the rule it
   * uses); both 更新目录; every book 替换净化.
   */
  kind?: "txt" | "epub" | "online";
  /** The contents a converted book kept from its source. */
  fixed?: boolean;
  /** A comic's chapters: no text tools. */
  comic?: boolean;
  /** 章内分章 is on (online books). */
  innerChapters?: boolean;
  onToggleInner?: () => void;
  onOpenUntitled?: () => void;
  onOpenReplace?: () => void;
  onUpdateToc?: () => void;
}

const CHAPTER_ROW = 46;
/** A chapter with its update time or length on a second line. */
const DETAILED_ROW = 56;
const VOLUME_ROW = 40;

/** Chapter counts in the form Legado shows, e.g. 3256字 or 1.2万字. */
export function formatLength(units: number): string {
  if (currentLocale() === "en")
    return units >= 1_000 ? `${(units / 1_000).toFixed(1)}k` : `${units}`;
  return units >= 10_000 ? `${(units / 10_000).toFixed(1)}万字` : `${units}字`;
}

/**
 * Legado's directory screen: 目录 and 书签 tabs, collapsible volumes, the
 * current chapter highlighted and centred, filtering, and the TXT rule tools.
 * The whole-book slider and 自动识别/全文 tabs of the old panel are gone.
 */
export function ContentsPage({
  bookTitle,
  toc,
  ruleName,
  splitLongChapters,
  position,
  loading,
  error,
  busy,
  bookmarks,
  contentVersion,
  onReload,
  onSeek,
  onOpenBookmark,
  onDeleteBookmark,
  onEditBookmark,
  onOpenRules,
  onToggleSplit,
  onClose,
  resourceId,
  kind = "txt",
  fixed = false,
  comic = false,
  innerChapters = false,
  onToggleInner,
  onOpenUntitled,
  onOpenReplace,
  onUpdateToc,
}: ContentsPageProps) {
  useErrorToast(error, "reader-contents");
  // A converted book's contents are its source's: no rule to pick or tune.
  const txtTools = kind === "txt" && !fixed && !comic;
  const [tab, setTab] = useState<"toc" | "bookmarks">("toc");
  const [filter, setFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [reversed, setReversed] = useState(false);
  const [showLength, setShowLength] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLButtonElement>(null);

  const currentIndex = useMemo(() => {
    if (resourceId !== undefined) {
      // A chapter, or the last of the chapters found inside it at or
      // before the page.
      let found = -1;
      toc.forEach((entry, index) => {
        if (
          entry.locator.resourceId === resourceId &&
          (found < 0 || entry.locator.offset <= position)
        )
          found = index;
      });
      return found;
    }
    let found = -1;
    for (let index = 0; index < toc.length; index += 1) {
      if (toc[index].locator.offset <= position) found = index;
      else break;
    }
    return found;
  }, [toc, position, resourceId]);

  const rows = useMemo(() => {
    const query = filter?.trim();
    if (query) return toc.filter((entry) => entry.title.includes(query));
    const visible: TocEntry[] = [];
    let hiddenVolume = false;
    for (const entry of toc) {
      if (entry.volume) {
        hiddenVolume = collapsed.has(entry.ordinal);
        visible.push(entry);
      } else if (!hiddenVolume) visible.push(entry);
    }
    return reversed ? visible.reverse() : visible;
  }, [toc, filter, collapsed, reversed]);

  // Long contents render only the rows near the screen, at fixed heights.
  const volumeRow = useCallback(
    (entry: TocEntry | undefined) => Boolean(entry?.volume && !filter?.trim()),
    [filter],
  );
  /** A chapter's second line: the source's update time, then its length when shown. */
  const rowDetails = useCallback(
    (entry: TocEntry) =>
      [chapterTag(entry.tag), showLength ? formatLength(entry.length) : ""]
        .filter(Boolean)
        .join(" · "),
    [showLength],
  );
  const heightOf = useCallback(
    (index: number) =>
      volumeRow(rows[index])
        ? VOLUME_ROW
        : rows[index] && rowDetails(rows[index])
          ? DETAILED_ROW
          : CHAPTER_ROW,
    [rows, volumeRow, rowDetails],
  );
  const windowed = useWindowedList(list, tab === "toc" ? rows.length : 0, heightOf);
  const currentRow = rows.findIndex((entry) => entry.ordinal === toc[currentIndex]?.ordinal);
  useLayoutEffect(() => {
    if (tab === "toc") windowed.scrollToIndex(currentRow);
  }, [tab]);

  const volumes = toc.filter((entry) => entry.volume);
  const toggleVolume = (ordinal: number) =>
    setCollapsed((value) => {
      const next = new Set(value);
      if (next.has(ordinal)) next.delete(ordinal);
      else next.add(ordinal);
      return next;
    });
  const locate = () => windowed.scrollToIndex(currentRow);
  const currentEntry = currentIndex >= 0 ? toc[currentIndex] : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("detail.contents")}
      data-open=""
      className="fixed inset-0 z-[45] bg-surface text-on-surface flex flex-col pt-safe pb-safe"
    >
      <header className="shrink-0 border-b border-surface-variant/30">
        <div className="h-14 px-2 flex items-center gap-1 max-w-3xl mx-auto w-full">
          <Button
            aria-label={t("detail.backToReading")}
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full text-secondary shrink-0"
            onClick={onClose}
          >
            <Icon name="arrow_back" size={20} />
          </Button>
          {filter === null ? (
            <h2 className="flex-1 min-w-0 truncate font-title-editorial text-[15px] font-semibold">
              {bookTitle}
            </h2>
          ) : (
            <Input
              autoFocus
              aria-label={
                tab === "toc" ? t("contents.searchChapters") : t("contents.searchBookmarks")
              }
              placeholder={
                tab === "toc" ? t("contents.searchChapters") : t("contents.searchBookmarks")
              }
              className="flex-1 h-9"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          <Button
            aria-label={filter === null ? t("contents.search") : t("contents.closeSearch")}
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full text-secondary shrink-0"
            onClick={() => setFilter((value) => (value === null ? "" : null))}
          >
            <Icon name={filter === null ? "search" : "close"} size={19} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("contents.options")}
              className="h-9 w-9 rounded-full flex items-center justify-center text-secondary hover:bg-surface-container/60 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 shrink-0"
            >
              <Icon name="more_vert" size={19} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {txtTools || (kind === "online" && !comic) ? (
                <DropdownMenuItem onClick={onOpenRules}>
                  <Icon name="toc_rule" size={15} />
                  {t("settings.toc")}
                </DropdownMenuItem>
              ) : null}
              {kind === "online" && !comic && onToggleInner && (
                <DropdownMenuItem disabled={busy} onClick={onToggleInner}>
                  <Icon name="call_split" size={15} />
                  {t("contents.innerChapters")}
                  <Checkmark on={innerChapters} />
                </DropdownMenuItem>
              )}
              {txtTools && (
                <DropdownMenuItem disabled={busy} onClick={onToggleSplit}>
                  <Icon name="content_cut" size={15} />
                  {t("tocRule.split")}
                  <Checkmark on={splitLongChapters} />
                </DropdownMenuItem>
              )}
              {txtTools && onOpenUntitled && (
                <DropdownMenuItem onClick={onOpenUntitled}>
                  <Icon name="title" size={15} />
                  {t("contents.untitled")}
                </DropdownMenuItem>
              )}
              {onOpenReplace && (
                <DropdownMenuItem onClick={onOpenReplace}>
                  <Icon name="find_replace" size={15} />
                  {t("settings.replace")}
                </DropdownMenuItem>
              )}
              {(kind === "online" || txtTools) && onUpdateToc && (
                <DropdownMenuItem disabled={busy} onClick={onUpdateToc}>
                  <Icon name="refresh" size={15} />
                  {t("shelf.menu.update")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setReversed((value) => !value)}>
                <Icon name="swap_vert" size={15} />
                {t("contents.reverse")}
                <Checkmark on={reversed} />
              </DropdownMenuItem>
              {kind === "txt" && !comic && (
                <DropdownMenuItem onClick={() => setShowLength((value) => !value)}>
                  <Icon name="format_list_numbered" size={15} />
                  {t("contents.lengths")}
                  <Checkmark on={showLength} />
                </DropdownMenuItem>
              )}
              {volumes.length > 0 && (
                <DropdownMenuItem
                  onClick={() =>
                    setCollapsed((value) =>
                      value.size ? new Set() : new Set(volumes.map((entry) => entry.ordinal)),
                    )
                  }
                >
                  <Icon name={collapsed.size ? "expand_more" : "expand_less"} size={15} />
                  {collapsed.size ? t("contents.expandAll") : t("contents.collapseAll")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div
          role="tablist"
          aria-label={t("contents.tabs")}
          className="flex max-w-3xl mx-auto w-full"
        >
          {(
            [
              [
                "toc",
                toc.length ? t("contents.tabToc", { count: toc.length }) : t("detail.contents"),
              ],
              [
                "bookmarks",
                bookmarks.length
                  ? t("contents.tabBookmarks", { count: bookmarks.length })
                  : t("contents.bookmarks"),
              ],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={`flex-1 py-2.5 text-sm transition-colors border-b-2 ${tab === value ? "border-primary text-primary font-medium" : "border-transparent text-secondary"}`}
              onClick={() => {
                setTab(value);
                setFilter(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div ref={list} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="max-w-3xl mx-auto w-full">
          {error && <LoadFailed onRetry={onReload} />}
          {loading && (
            <p role="status" className="m-4 text-sm text-secondary">
              {t("contents.loading")}
            </p>
          )}
          {tab === "toc" && rows.length > 0 && <div style={{ height: windowed.before }} />}
          {tab === "toc" &&
            rows.slice(windowed.start, windowed.end).map((entry) => {
              const isCurrent = currentEntry !== null && entry.ordinal === currentEntry.ordinal;
              if (entry.volume && !filter?.trim())
                return (
                  <div
                    key={entry.ordinal}
                    className="flex items-end gap-1 px-4 pb-1 text-xs text-secondary"
                    style={{ height: VOLUME_ROW }}
                  >
                    <button
                      className="flex-1 min-w-0 text-left truncate font-medium hover:text-on-surface"
                      onClick={() => onSeek(entry.locator)}
                    >
                      {entry.title}
                    </button>
                    <button
                      aria-label={
                        collapsed.has(entry.ordinal)
                          ? t("contents.expand", { title: entry.title })
                          : t("contents.collapse", { title: entry.title })
                      }
                      aria-expanded={!collapsed.has(entry.ordinal)}
                      className="h-7 w-7 flex items-center justify-center rounded-full hover:bg-surface-container"
                      onClick={() => toggleVolume(entry.ordinal)}
                    >
                      <Icon
                        name={collapsed.has(entry.ordinal) ? "expand_more" : "expand_less"}
                        size={15}
                      />
                    </button>
                  </div>
                );
              const details = rowDetails(entry);
              return (
                <button
                  key={entry.ordinal}
                  ref={isCurrent ? current : undefined}
                  aria-current={isCurrent ? "location" : undefined}
                  className={`w-full flex items-center gap-3 px-4 text-left text-sm border-b border-surface-variant/20 transition-colors ${isCurrent ? "text-primary bg-surface-container font-medium" : "hover:bg-surface-container/60"}`}
                  style={{ height: details ? DETAILED_ROW : CHAPTER_ROW }}
                  onClick={() => onSeek(entry.locator)}
                >
                  <span
                    className={`flex-1 min-w-0 ${
                      // Found inside an online chapter: under it.
                      kind === "online" && entry.locator.offset > 0 ? "pl-4 text-[13px]" : ""
                    }`}
                  >
                    <span className="block truncate">{entry.title}</span>
                    {details && (
                      <span className="block mt-0.5 text-[11px] font-normal text-secondary tabular-nums truncate">
                        {details}
                      </span>
                    )}
                  </span>
                  {isCurrent && <Icon name="my_location" size={14} className="shrink-0" />}
                </button>
              );
            })}
          {tab === "toc" && rows.length > 0 && <div style={{ height: windowed.after }} />}
          {tab === "toc" && !loading && !error && toc.length === 0 && (
            <p className="m-4 text-sm text-secondary">
              {kind === "txt" ? t("contents.noChapters") : t("contents.empty")}
            </p>
          )}
          {tab === "bookmarks" &&
            bookmarks
              .filter(
                (bookmark) =>
                  !filter?.trim() ||
                  bookmark.excerpt.includes(filter.trim()) ||
                  bookmark.note.includes(filter.trim()),
              )
              .map((bookmark) => {
                const stale = bookmark.contentVersion !== contentVersion;
                return (
                  <div
                    key={bookmark.id}
                    className="flex items-start gap-2 px-4 py-3 border-b border-surface-variant/20"
                  >
                    <button
                      className="flex-1 min-w-0 text-left space-y-1"
                      onClick={() => onOpenBookmark(bookmark)}
                    >
                      <p className="text-sm line-clamp-2">
                        {bookmark.excerpt || t("contents.blank")}
                      </p>
                      {bookmark.note && (
                        <p className="text-xs text-primary line-clamp-3 break-words">
                          {bookmark.note}
                        </p>
                      )}
                      <p className="text-[11px] text-secondary">
                        {chapterTitleAt(toc, bookmark.locator, resourceId !== undefined)}
                        {stale ? t("contents.stale") : ""}
                      </p>
                    </button>
                    <Button
                      aria-label={t("contents.editNote")}
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-secondary shrink-0"
                      onClick={() => onEditBookmark(bookmark)}
                    >
                      <Icon name="edit" size={15} />
                    </Button>
                    <Button
                      aria-label={t("contents.deleteBookmark")}
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-secondary shrink-0"
                      onClick={() => onDeleteBookmark(bookmark)}
                    >
                      <Icon name="delete" size={15} />
                    </Button>
                  </div>
                );
              })}
          {tab === "bookmarks" && bookmarks.length === 0 && !loading && (
            <p className="m-4 text-sm text-secondary">{t("contents.noBookmarks")}</p>
          )}
        </div>
      </div>

      {tab === "toc" && (
        <footer className="shrink-0 border-t border-surface-variant/30">
          <div className="max-w-3xl mx-auto w-full flex items-center gap-1 px-3 py-1.5">
            <div className="flex-1 min-w-0">
              <p className="text-xs truncate">{currentEntry?.title ?? t("shelf.wholeText")}</p>
              <p className="text-[11px] text-secondary">
                {currentIndex + 1}/{toc.length}
                {/* A comic has no chapter rule; an online one names its source. */}
                {comic && !ruleName ? "" : ` · ${ruleName || t("reader.encoding.auto")}`}
              </p>
            </div>
            <Button
              aria-label={t("contents.top")}
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-secondary"
              onClick={() => list.current?.scrollTo({ top: 0 })}
            >
              <Icon name="vertical_align_top" size={18} />
            </Button>
            <Button
              aria-label={t("contents.current")}
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-secondary"
              onClick={locate}
            >
              <Icon name="my_location" size={18} />
            </Button>
            <Button
              aria-label={t("contents.bottom")}
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-secondary"
              onClick={() => list.current?.scrollTo({ top: list.current.scrollHeight })}
            >
              <Icon name="vertical_align_bottom" size={18} />
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}

/** A menu toggle that is on: a check mark at the end of its row. */
function Checkmark({ on }: { on: boolean }) {
  return on ? <Icon name="check" size={15} className="ml-auto text-primary" /> : null;
}

function chapterTitleAt(toc: TocEntry[], locator: ReaderLocator, byResource: boolean): string {
  if (byResource)
    return toc.find((entry) => entry.locator.resourceId === locator.resourceId)?.title ?? "";
  const offset = locator.offset;
  let title = "";
  for (const entry of toc) {
    if (entry.locator.offset <= offset) title = entry.title;
    else break;
  }
  return title || t("contents.start");
}

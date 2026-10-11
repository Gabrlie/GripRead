import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
}

/** Chapter counts in the form Legado shows, e.g. 3256字 or 1.2万字. */
export function formatLength(units: number): string {
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
}: ContentsPageProps) {
  const [tab, setTab] = useState<"toc" | "bookmarks">("toc");
  const [filter, setFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [reversed, setReversed] = useState(false);
  const [showLength, setShowLength] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLButtonElement>(null);

  const currentIndex = useMemo(() => {
    let found = -1;
    for (let index = 0; index < toc.length; index += 1) {
      if (toc[index].locator.offset <= position) found = index;
      else break;
    }
    return found;
  }, [toc, position]);

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

  useLayoutEffect(() => {
    if (tab === "toc") current.current?.scrollIntoView?.({ block: "center" });
  }, [tab]);

  const volumes = toc.filter((entry) => entry.volume);
  const toggleVolume = (ordinal: number) =>
    setCollapsed((value) => {
      const next = new Set(value);
      if (next.has(ordinal)) next.delete(ordinal);
      else next.add(ordinal);
      return next;
    });
  const locate = () => current.current?.scrollIntoView?.({ block: "center" });
  const currentEntry = currentIndex >= 0 ? toc[currentIndex] : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="目录"
      data-open=""
      className="fixed inset-0 z-[45] bg-surface text-on-surface flex flex-col pt-safe pb-safe"
    >
      <header className="shrink-0 border-b border-surface-variant/30">
        <div className="h-14 px-2 flex items-center gap-1 max-w-3xl mx-auto w-full">
          <Button
            aria-label="返回阅读"
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
              aria-label={tab === "toc" ? "搜索章节" : "搜索书签"}
              placeholder={tab === "toc" ? "搜索章节" : "搜索书签"}
              className="flex-1 h-9"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          <Button
            aria-label={filter === null ? "搜索目录" : "关闭搜索"}
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full text-secondary shrink-0"
            onClick={() => setFilter((value) => (value === null ? "" : null))}
          >
            <Icon name={filter === null ? "search" : "close"} size={19} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="目录选项"
              className="h-9 w-9 rounded-full flex items-center justify-center text-secondary hover:bg-surface-container/60 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 shrink-0"
            >
              <Icon name="more_vert" size={19} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={onOpenRules}>
                <Icon name="toc_rule" size={15} />
                TXT目录规则
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onClick={onToggleSplit}>
                <Checkmark on={splitLongChapters} />
                拆分超长章节
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setReversed((value) => !value)}>
                <Checkmark on={reversed} />
                倒序显示
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowLength((value) => !value)}>
                <Checkmark on={showLength} />
                显示字数
              </DropdownMenuItem>
              {volumes.length > 0 && (
                <DropdownMenuItem
                  onClick={() =>
                    setCollapsed((value) =>
                      value.size ? new Set() : new Set(volumes.map((entry) => entry.ordinal)),
                    )
                  }
                >
                  <Icon name={collapsed.size ? "expand_more" : "expand_less"} size={15} />
                  {collapsed.size ? "展开全部卷" : "收起全部卷"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div role="tablist" aria-label="目录与书签" className="flex max-w-3xl mx-auto w-full">
          {(
            [
              ["toc", `目录${toc.length ? ` ${toc.length}` : ""}`],
              ["bookmarks", `书签${bookmarks.length ? ` ${bookmarks.length}` : ""}`],
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
          {error && (
            <div role="alert" className="m-4 text-sm text-error space-y-2">
              <p>{error}</p>
              <Button variant="outline" size="sm" onClick={onReload}>
                重新加载
              </Button>
            </div>
          )}
          {loading && (
            <p role="status" className="m-4 text-sm text-secondary">
              正在读取目录…
            </p>
          )}
          {tab === "toc" &&
            rows.map((entry) => {
              const isCurrent = currentEntry !== null && entry.ordinal === currentEntry.ordinal;
              if (entry.volume && !filter?.trim())
                return (
                  <div
                    key={entry.ordinal}
                    className="flex items-center gap-1 px-4 pt-4 pb-1.5 text-xs text-secondary"
                    style={{ contentVisibility: "auto", containIntrinsicSize: "auto 36px" }}
                  >
                    <button
                      className="flex-1 min-w-0 text-left truncate font-medium hover:text-on-surface"
                      onClick={() => onSeek(entry.locator)}
                    >
                      {entry.title}
                    </button>
                    <button
                      aria-label={
                        collapsed.has(entry.ordinal) ? `展开 ${entry.title}` : `收起 ${entry.title}`
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
              return (
                <button
                  key={entry.ordinal}
                  ref={isCurrent ? current : undefined}
                  aria-current={isCurrent ? "location" : undefined}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left text-sm border-b border-surface-variant/20 transition-colors ${isCurrent ? "text-primary bg-surface-container font-medium" : "hover:bg-surface-container/60"}`}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 46px" }}
                  onClick={() => onSeek(entry.locator)}
                >
                  <span className="flex-1 min-w-0 truncate">{entry.title}</span>
                  {showLength && (
                    <span className="text-[11px] text-secondary tabular-nums shrink-0">
                      {formatLength(entry.length)}
                    </span>
                  )}
                  {isCurrent && <Icon name="my_location" size={14} className="shrink-0" />}
                </button>
              );
            })}
          {tab === "toc" && !loading && !error && toc.length === 0 && (
            <p className="m-4 text-sm text-secondary">
              没有识别到章节，可以在 TXT目录规则 中换一条规则。
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
                      <p className="text-sm line-clamp-2">{bookmark.excerpt || "（空白位置）"}</p>
                      {bookmark.note && (
                        <p className="text-xs text-primary line-clamp-3 break-words">
                          {bookmark.note}
                        </p>
                      )}
                      <p className="text-[11px] text-secondary">
                        {chapterTitleAt(toc, bookmark.locator.offset)}
                        {stale ? " · 旧正文版本" : ""}
                      </p>
                    </button>
                    <Button
                      aria-label="编辑书签备注"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-secondary shrink-0"
                      onClick={() => onEditBookmark(bookmark)}
                    >
                      <Icon name="edit" size={15} />
                    </Button>
                    <Button
                      aria-label="删除书签"
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
            <p className="m-4 text-sm text-secondary">
              还没有书签。可以在右上角添加，或长按选中文字后添加。
            </p>
          )}
        </div>
      </div>

      {tab === "toc" && (
        <footer className="shrink-0 border-t border-surface-variant/30">
          <div className="max-w-3xl mx-auto w-full flex items-center gap-1 px-3 py-1.5">
            <div className="flex-1 min-w-0">
              <p className="text-xs truncate">{currentEntry?.title ?? "全文"}</p>
              <p className="text-[11px] text-secondary">
                {currentIndex + 1}/{toc.length} · {ruleName || "自动识别"}
              </p>
            </div>
            <Button
              aria-label="回到顶部"
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-secondary"
              onClick={() => list.current?.scrollTo({ top: 0 })}
            >
              <Icon name="vertical_align_top" size={18} />
            </Button>
            <Button
              aria-label="定位当前章节"
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-secondary"
              onClick={locate}
            >
              <Icon name="my_location" size={18} />
            </Button>
            <Button
              aria-label="滚到底部"
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

/** A menu toggle's state: a check mark, or the same space left blank. */
function Checkmark({ on }: { on: boolean }) {
  return on ? <Icon name="check" size={15} /> : <span aria-hidden="true" className="w-[15px]" />;
}

function chapterTitleAt(toc: TocEntry[], offset: number): string {
  let title = "";
  for (const entry of toc) {
    if (entry.locator.offset <= offset) title = entry.title;
    else break;
  }
  return title || "开头";
}

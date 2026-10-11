import type { SearchMatch, TocEntry } from "../../../types/generated";
import type { ReaderSearch } from "../use-reader-search";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/Icon";
import { Input } from "../../ui/input";

interface SearchPageProps {
  search: ReaderSearch;
  toc: TocEntry[];
  totalLength: number;
  onOpenMatch: (index: number) => void;
  onClose: () => void;
}

function chapterAt(toc: TocEntry[], offset: number): string {
  let title = "";
  for (const entry of toc) {
    if (entry.locator.offset <= offset) title = entry.title;
    else break;
  }
  return title;
}

/** The first occurrence of the query in an excerpt, as `[start, end)`. */
function occurrence(excerpt: string, query: string, regex: boolean): [number, number] | null {
  if (!query) return null;
  if (!regex) {
    const index = excerpt.indexOf(query);
    return index < 0 ? null : [index, index + query.length];
  }
  try {
    // JavaScript syntax covers the common expressions; others show unmarked.
    const found = new RegExp(query, "u").exec(excerpt);
    return found && found[0] ? [found.index, found.index + found[0].length] : null;
  } catch {
    return null;
  }
}

/** Splits an excerpt around the first occurrence of the query for emphasis. */
function emphasize(excerpt: string, query: string, regex: boolean) {
  const range = occurrence(excerpt, query, regex);
  if (!range) return <>{excerpt}</>;
  return (
    <>
      {excerpt.slice(0, range[0])}
      <mark className="bg-primary/15 text-primary rounded-sm px-0.5 font-medium">
        {excerpt.slice(range[0], range[1])}
      </mark>
      {excerpt.slice(range[1])}
    </>
  );
}

/**
 * Legado's in-book search screen: results carry their chapter, surrounding
 * text with the match emphasized, and their position in the book.
 */
export function SearchPage({ search, toc, totalLength, onOpenMatch, onClose }: SearchPageProps) {
  const percent = (match: SearchMatch) =>
    totalLength > 0 ? `${((match.matchStart / totalLength) * 100).toFixed(1)}%` : "";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="搜索正文"
      data-open=""
      className="fixed inset-0 z-[45] bg-surface text-on-surface flex flex-col pt-safe pb-safe"
    >
      <header className="shrink-0 border-b border-surface-variant/30">
        <form
          className="h-14 px-2 flex items-center gap-1.5 max-w-3xl mx-auto w-full"
          onSubmit={(event) => {
            event.preventDefault();
            search.search();
          }}
        >
          <Button
            type="button"
            aria-label="返回阅读"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full text-secondary shrink-0"
            onClick={onClose}
          >
            <Icon name="arrow_back" size={20} />
          </Button>
          <Input
            autoFocus
            aria-label="搜索关键词"
            placeholder="搜索正文"
            className="flex-1 h-9"
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="正则表达式"
            aria-pressed={search.regex}
            title="正则表达式"
            className={`h-9 w-9 rounded-full shrink-0 ${search.regex ? "text-primary bg-primary/10" : "text-secondary"}`}
            onClick={() => search.setRegex(!search.regex)}
          >
            <Icon name="regex" size={18} />
          </Button>
          {search.searching ? (
            <Button type="button" variant="ghost" className="h-9 shrink-0" onClick={search.cancel}>
              停止
            </Button>
          ) : (
            <Button
              type="submit"
              variant="ghost"
              className="h-9 shrink-0 text-primary"
              disabled={!search.query.trim()}
            >
              搜索
            </Button>
          )}
        </form>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="max-w-3xl mx-auto w-full p-3 space-y-2">
          {search.error && (
            <p role="alert" className="text-sm text-error">
              {search.error}
            </p>
          )}
          {search.searching && search.matches.length === 0 && (
            <p role="status" className="text-sm text-secondary px-1">
              正在搜索…
            </p>
          )}
          {search.complete && search.matches.length === 0 && (
            <p className="text-sm text-secondary px-1">没有找到“{search.query}”。</p>
          )}
          {search.matches.length > 0 && (
            <p className="text-xs text-secondary px-1">
              {search.hasMore
                ? `已找到 ${search.matches.length} 处以上`
                : `共 ${search.matches.length} 处`}
            </p>
          )}
          {search.matches.map((match, index) => (
            <button
              key={`${match.ordinal}-${match.matchStart}`}
              className="w-full text-left rounded-xl bg-surface-container-low hover:bg-surface-container px-3.5 py-3 space-y-1.5 transition-colors"
              onClick={() => onOpenMatch(index)}
            >
              <span className="flex items-center gap-2 text-xs">
                <span className="flex-1 min-w-0 truncate text-primary font-medium">
                  {chapterAt(toc, match.matchStart) || "开头"}
                </span>
                <span className="text-secondary tabular-nums shrink-0">{percent(match)}</span>
              </span>
              <span className="block text-sm leading-relaxed text-on-surface/90 break-words">
                {emphasize(match.excerpt, search.query, search.regex)}
              </span>
            </button>
          ))}
          {search.hasMore && (
            <Button
              variant="outline"
              className="w-full"
              disabled={search.searching}
              onClick={search.loadMore}
            >
              加载更多
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

interface SearchResultBarProps {
  index: number;
  count: number;
  hasMore: boolean;
  onStep: (direction: -1 | 1) => void;
  onList: () => void;
  onExit: () => void;
}

/** Shown over the page after opening a result, like Legado's search menu. */
export function SearchResultBar({
  index,
  count,
  hasMore,
  onStep,
  onList,
  onExit,
}: SearchResultBarProps) {
  return (
    <div className="fixed bottom-0 inset-x-0 z-30 pb-safe pointer-events-none">
      <div className="max-w-md mx-auto m-3 rounded-2xl bg-surface/95 backdrop-blur-xl border border-surface-variant/40 shadow-sm flex items-center gap-1 px-2 py-1.5 pointer-events-auto">
        <Button
          aria-label="上一个结果"
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          disabled={index <= 0}
          onClick={() => onStep(-1)}
        >
          <Icon name="chevron_left" size={20} />
        </Button>
        <button className="flex-1 text-center text-xs text-secondary py-2" onClick={onList}>
          第 {index + 1}/{count}
          {hasMore ? "+" : ""} 处 · 结果列表
        </button>
        <Button
          aria-label="下一个结果"
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          disabled={index >= count - 1}
          onClick={() => onStep(1)}
        >
          <Icon name="chevron_right" size={20} />
        </Button>
        <Button
          aria-label="退出搜索"
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={onExit}
        >
          <Icon name="close" size={18} />
        </Button>
      </div>
    </div>
  );
}

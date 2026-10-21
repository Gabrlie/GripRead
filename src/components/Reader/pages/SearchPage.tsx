import type { SearchMatch, TocEntry } from "../../../types/generated";
import type { ReaderSearch } from "../use-reader-search";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/Icon";
import { Input } from "../../ui/input";
import { t } from "../../../i18n";
import { useErrorToast } from "../../ui/toast";

interface SearchPageProps {
  search: ReaderSearch;
  toc: TocEntry[];
  totalLength: number;
  onOpenMatch: (index: number) => void;
  onClose: () => void;
  /** An online book: chapters are resources, and only kept ones are searched. */
  byResource?: boolean;
}

function chapterAt(toc: TocEntry[], match: SearchMatch, byResource: boolean): string {
  // A book read chapter by chapter names the chapter by its resource.
  if (byResource)
    return toc.find((entry) => entry.locator.resourceId === match.locator.resourceId)?.title ?? "";
  const offset = match.matchStart;
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
export function SearchPage({
  search,
  toc,
  totalLength,
  onOpenMatch,
  onClose,
  byResource = false,
}: SearchPageProps) {
  useErrorToast(search.error, "reader-search");
  const percent = (match: SearchMatch) =>
    totalLength > 0 ? `${((match.matchStart / totalLength) * 100).toFixed(1)}%` : "";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("search.title")}
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
            aria-label={t("detail.backToReading")}
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full text-secondary shrink-0"
            onClick={onClose}
          >
            <Icon name="arrow_back" size={20} />
          </Button>
          <Input
            autoFocus
            aria-label={t("search.query")}
            placeholder={t("search.title")}
            className="flex-1 h-9"
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("search.regex")}
            aria-pressed={search.regex}
            title={t("search.regex")}
            className={`h-9 w-9 rounded-full shrink-0 ${search.regex ? "text-primary bg-primary/10" : "text-secondary"}`}
            onClick={() => search.setRegex(!search.regex)}
          >
            <Icon name="regex" size={18} />
          </Button>
          {search.searching ? (
            <Button type="button" variant="ghost" className="h-9 shrink-0" onClick={search.cancel}>
              {t("search.stop")}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="ghost"
              className="h-9 shrink-0 text-primary"
              disabled={!search.query.trim()}
            >
              {t("header.search")}
            </Button>
          )}
        </form>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="max-w-3xl mx-auto w-full p-3 space-y-2">
          {search.searching && search.matches.length === 0 && (
            <p role="status" className="text-sm text-secondary px-1">
              {t("search.searching")}
            </p>
          )}
          {byResource && (
            <p className="text-[11px] text-secondary px-1">{t("search.cachedOnly")}</p>
          )}
          {search.complete && search.matches.length === 0 && (
            <p className="text-sm text-secondary px-1">
              {t("search.none", { query: search.query })}
            </p>
          )}
          {search.matches.length > 0 && (
            <p className="text-xs text-secondary px-1">
              {search.hasMore
                ? t("search.more", { count: search.matches.length })
                : t("search.count", { count: search.matches.length })}
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
                  {chapterAt(toc, match, byResource) || t("contents.start")}
                </span>
                {!byResource && (
                  <span className="text-secondary tabular-nums shrink-0">{percent(match)}</span>
                )}
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
              {t("search.loadMore")}
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
          aria-label={t("search.previous")}
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          disabled={index <= 0}
          onClick={() => onStep(-1)}
        >
          <Icon name="chevron_left" size={20} />
        </Button>
        <button className="flex-1 text-center text-xs text-secondary py-2" onClick={onList}>
          {t("search.position", { index: index + 1, count, more: hasMore ? "+" : "" })}
        </button>
        <Button
          aria-label={t("search.next")}
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          disabled={index >= count - 1}
          onClick={() => onStep(1)}
        >
          <Icon name="chevron_right" size={20} />
        </Button>
        <Button
          aria-label={t("search.leave")}
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

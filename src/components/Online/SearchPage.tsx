import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type {
  BookSourceSummary,
  LibraryBook,
  OnlineSearchEvent,
  OnlineSearchResult,
  SearchScope,
} from "../../types/generated";
import {
  ALL_SOURCES,
  type OnlineReturn,
  clearSearchHistory,
  describeScope,
  readSearchHistory,
  rememberSearch,
} from "../../application/online";
import { sourceGroups } from "../../application/sources";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { OnlineCover } from "./OnlineCover";
import { OnlineBookPage } from "./OnlineBookPage";
import { TitleTranslationChip } from "./TitleTranslationChip";
import { useTitleTranslation } from "./use-title-translation";
import { t } from "../../i18n";

/**
 * Legado's 搜索: every chosen source is asked at once and results arrive as
 * they come, folded by name and author with a count of sources; 精准搜索
 * keeps only results whose name or author contains the keyword.
 */
export function SearchPage({
  service,
  initialScope = ALL_SOURCES,
  initialKey = "",
  restored,
  onRead,
  onClose,
}: {
  service: SourceService;
  initialScope?: SearchScope;
  initialKey?: string;
  /** The results and book page to show again after reading. */
  restored?: { event: OnlineSearchEvent | null; result: OnlineSearchResult; origin: number };
  onRead?: (book: LibraryBook, chapter: number | null, from: OnlineReturn) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState(initialKey);
  const [scope, setScope] = useState<SearchScope>(initialScope);
  const [precise, setPrecise] = useState(false);
  const [history, setHistory] = useState(readSearchHistory);
  const [event, setEvent] = useState<OnlineSearchEvent | null>(restored?.event ?? null);
  const shownTitles = useMemo(() => event?.results.map((result) => result.name) ?? [], [event]);
  const titles = useTitleTranslation(shownTitles);
  const [opened, setOpened] = useState<{ result: OnlineSearchResult; origin: number } | null>(
    restored ? { result: restored.result, origin: restored.origin } : null,
  );
  const [choosingScope, setChoosingScope] = useState(false);
  const [sources, setSources] = useState<BookSourceSummary[]>([]);
  const operation = useRef<string | null>(null);

  useEffect(() => {
    void service.listSources().then(setSources, () => undefined);
  }, [service]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;
    void service
      .onSearch((next) => {
        if (next.operationId !== operation.current) return;
        setEvent(next);
        if (next.done) operation.current = null;
      })
      .then((stop) => {
        if (active) unsubscribe = stop;
        else stop();
      });
    return () => {
      active = false;
      unsubscribe?.();
      if (operation.current) void service.cancel(operation.current);
    };
  }, [service]);

  const start = (keyword = key) => {
    const trimmed = keyword.trim();
    if (!trimmed) return;
    if (operation.current) void service.cancel(operation.current);
    const operationId = `search-${Date.now()}`;
    operation.current = operationId;
    setKey(trimmed);
    setHistory(rememberSearch(trimmed));
    setEvent({ operationId, searched: 0, total: 0, done: false, results: [], failures: [] });
    void service
      .search({ operationId, key: trimmed, scope, precise, page: 1 })
      .catch((failure: unknown) => {
        operation.current = null;
        setEvent({
          operationId,
          searched: 0,
          total: 0,
          done: true,
          results: [],
          failures: [{ sourceName: t("header.search"), message: String(failure) }],
        });
      });
  };

  useEffect(() => {
    if (initialKey && !restored) start(initialKey);
  }, []);

  const stop = () => {
    if (operation.current) void service.cancel(operation.current);
    operation.current = null;
    setEvent((current) => current && { ...current, done: true });
  };

  const singleName =
    scope.sourceUrls.length === 1
      ? sources.find((source) => source.url === scope.sourceUrls[0])?.name
      : undefined;
  const running = event !== null && !event.done;

  return (
    <FullPage label={t("header.search")} onClose={onClose} layer="z-[44]">
      <form
        className="flex gap-2"
        onSubmit={(submit) => {
          submit.preventDefault();
          start();
        }}
      >
        <label className="flex-1 min-w-0 flex items-center gap-2 rounded-xl bg-surface-container-low px-3 h-10">
          <Icon name="search" size={16} className="text-secondary" />
          <input
            aria-label={t("onlineSearch.query")}
            placeholder={t("onlineSearch.query")}
            autoFocus={!initialKey}
            enterKeyHint="search"
            value={key}
            onChange={(change) => setKey(change.target.value)}
            className="flex-1 min-w-0 bg-transparent text-sm outline-none"
          />
          {key && (
            <button type="button" aria-label={t("data.clear")} onClick={() => setKey("")}>
              <Icon name="close" size={15} className="text-secondary" />
            </button>
          )}
        </label>
        {running ? (
          <Button type="button" variant="outline" onClick={stop}>
            {t("search.stop")}
          </Button>
        ) : (
          <Button type="submit" disabled={!key.trim()}>
            {t("header.search")}
          </Button>
        )}
      </form>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setChoosingScope(true)}
          className="h-7 px-3 rounded-full text-xs bg-surface-container-low text-secondary inline-flex items-center gap-1"
        >
          <Icon name="filter_list" size={13} />
          {describeScope(scope, singleName)}
        </button>
        <button
          type="button"
          aria-pressed={precise}
          onClick={() => setPrecise((value) => !value)}
          className={`h-7 px-3 rounded-full text-xs ${
            precise ? "bg-primary text-on-primary" : "bg-surface-container-low text-secondary"
          }`}
        >
          {t("onlineSearch.exact")}
        </button>
        <TitleTranslationChip titles={titles} />
      </div>

      {event === null && history.length > 0 && (
        <section aria-label={t("onlineSearch.history")} className="space-y-2">
          <div className="flex items-center justify-between px-1 text-[11px] text-secondary">
            {t("onlineSearch.history")}
            <button
              type="button"
              onClick={() => {
                clearSearchHistory();
                setHistory([]);
              }}
            >
              {t("data.clear")}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {history.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => start(item)}
                className="h-7 px-3 rounded-full text-xs bg-surface-container-low"
              >
                {item}
              </button>
            ))}
          </div>
        </section>
      )}

      {event && (
        <div role="status" className="px-1 text-[11px] text-secondary flex items-center gap-2">
          {running ? (
            <span className="h-1 flex-1 rounded-full bg-surface-container overflow-hidden">
              <span
                className="block h-full bg-primary transition-[width]"
                style={{ width: event.total ? `${(event.searched / event.total) * 100}%` : "8%" }}
              />
            </span>
          ) : null}
          <span>
            {running
              ? t("cover.searching", { done: event.searched, total: event.total })
              : t("onlineSearch.summary", { total: event.total, found: event.results.length })}
          </span>
        </div>
      )}

      {event?.done && event.results.length === 0 && (
        <p className="py-8 text-center text-sm text-secondary">
          {event.total === 0 ? t("onlineSearch.noSources") : t("onlineSearch.none")}
        </p>
      )}

      <ul className="space-y-1.5" aria-label={t("onlineSearch.results")}>
        {event?.results.map((result) => (
          <SearchResultRow
            key={`${result.name}\n${result.author}`}
            service={service}
            result={result}
            translatedName={titles.title(result.name)}
            onOpen={() => setOpened({ result, origin: 0 })}
          />
        ))}
      </ul>

      {event && event.failures.length > 0 && event.done && (
        <details className="px-1 text-[11px] text-secondary">
          <summary>{t("onlineSearch.failures", { count: event.failures.length })}</summary>
          <ul className="mt-1 space-y-0.5">
            {event.failures.map((failure, index) => (
              <li key={index} className="break-words">
                {failure.sourceName}：{failure.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {opened && (
        <OnlineBookPage
          service={service}
          result={opened.result}
          initialOrigin={opened.origin}
          onRead={
            onRead &&
            ((book, origin, chapter) =>
              onRead(book, chapter, {
                view: "search",
                scope,
                key,
                event: event && { ...event, done: true },
                result: opened.result,
                origin,
              }))
          }
          onClose={() => setOpened(null)}
        />
      )}
      {choosingScope && (
        <ScopeDialog
          sources={sources}
          scope={scope}
          onChoose={(next) => {
            setScope(next);
            setChoosingScope(false);
          }}
          onClose={() => setChoosingScope(false)}
        />
      )}
    </FullPage>
  );
}

export function SearchResultRow({
  service,
  result,
  translatedName,
  onOpen,
}: {
  service: SourceService;
  result: OnlineSearchResult;
  /** The title translated (列表 翻译), shown with the original below it. */
  translatedName?: string;
  onOpen: () => void;
}) {
  const first = result.origins[0];
  // The cover is fetched through the source that gave it.
  const covered = result.origins.find((origin) => origin.coverUrl) ?? first;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex gap-3 rounded-xl bg-surface-container-low p-2 text-left"
      >
        {/* The cover fills the row, so the margins above and below match. */}
        <span className="w-12 min-h-16 self-stretch shrink-0 rounded overflow-hidden bg-surface-container">
          <OnlineCover
            service={service}
            sourceUrl={covered?.sourceUrl ?? ""}
            url={covered?.coverUrl ?? result.coverUrl}
            title={result.name}
          />
        </span>
        <span className="flex-1 min-w-0 space-y-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{translatedName ?? result.name}</span>
            {result.origins.length > 1 && (
              <span className="shrink-0 rounded-full bg-primary/10 text-primary text-[10px] px-1.5 leading-4">
                {t("onlineSearch.origins", { count: result.origins.length })}
              </span>
            )}
          </span>
          {translatedName && (
            <span className="block text-[11px] text-secondary truncate">{result.name}</span>
          )}
          <span className="block text-[11px] text-secondary truncate">
            {[result.author, result.kind, result.wordCount].filter(Boolean).join(" · ")}
          </span>
          {result.latestChapterTitle && (
            <span className="block text-[11px] text-secondary truncate">
              {t("shelf.latest", { chapter: result.latestChapterTitle })}
            </span>
          )}
          {result.origins.length === 1 && (
            <span className="block text-[10px] text-secondary/70 truncate">
              {first?.sourceName}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function ScopeDialog({
  sources,
  scope,
  onChoose,
  onClose,
}: {
  sources: BookSourceSummary[];
  scope: SearchScope;
  onChoose: (scope: SearchScope) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [groups, setGroups] = useState<string[]>(scope.groups);
  const searchable = sources.filter((source) => source.hasSearch);
  const allGroups = useMemo(() => sourceGroups(searchable), [sources]);
  const shown = searchable.filter((source) =>
    source.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md max-h-[86dvh] p-5 gap-3 flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("onlineSearch.scope")}
          </DialogTitle>
        </DialogHeader>
        <Button variant="outline" size="sm" onClick={() => onChoose(ALL_SOURCES)}>
          {t("onlineSearch.allEnabled")}
        </Button>
        {allGroups.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] text-secondary">{t("onlineSearch.groups")}</p>
            <div className="flex flex-wrap gap-1.5">
              {allGroups.map((name) => {
                const on = groups.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setGroups(on ? groups.filter((item) => item !== name) : [...groups, name])
                    }
                    className={`h-7 px-3 rounded-full text-xs ${
                      on ? "bg-primary text-on-primary" : "bg-surface-container-low text-secondary"
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
            <Button
              size="sm"
              disabled={!groups.length}
              onClick={() => onChoose({ groups, sourceUrls: [] })}
            >
              {t("onlineSearch.searchGroups")}
            </Button>
          </div>
        )}
        <p className="text-[11px] text-secondary">{t("online.oneSource")}</p>
        <input
          aria-label={t("change.filter")}
          placeholder={t("field.source-name")}
          value={filter}
          onChange={(change) => setFilter(change.target.value)}
          className="h-9 rounded-lg bg-surface-container-low px-3 text-sm outline-none"
        />
        <ul className="flex-1 min-h-0 overflow-y-auto space-y-1">
          {shown.map((source) => (
            <li key={source.url}>
              <button
                type="button"
                onClick={() => onChoose({ groups: [], sourceUrls: [source.url] })}
                className="w-full text-left rounded-lg px-3 py-2 text-sm hover:bg-surface-container-low"
              >
                {source.name}
                {!source.enabled && (
                  <span className="ml-2 text-[11px] text-secondary">
                    {t("src.filter.disabled")}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

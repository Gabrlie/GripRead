import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type {
  BookSourceSummary,
  OnlineSearchEvent,
  OnlineSearchResult,
  SearchScope,
} from "../../types/generated";
import {
  ALL_SOURCES,
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

/**
 * Legado's 搜索: every chosen source is asked at once and results arrive as
 * they come, folded by name and author with a count of sources; 精准搜索
 * keeps only results whose name or author contains the keyword.
 */
export function SearchPage({
  service,
  initialScope = ALL_SOURCES,
  initialKey = "",
  onClose,
}: {
  service: SourceService;
  initialScope?: SearchScope;
  initialKey?: string;
  onClose: () => void;
}) {
  const [key, setKey] = useState(initialKey);
  const [scope, setScope] = useState<SearchScope>(initialScope);
  const [precise, setPrecise] = useState(false);
  const [history, setHistory] = useState(readSearchHistory);
  const [event, setEvent] = useState<OnlineSearchEvent | null>(null);
  const [opened, setOpened] = useState<OnlineSearchResult | null>(null);
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
          failures: [{ sourceName: "搜索", message: String(failure) }],
        });
      });
  };

  useEffect(() => {
    if (initialKey) start(initialKey);
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
    <FullPage label="搜索" onClose={onClose} layer="z-[44]">
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
            aria-label="书名或作者"
            placeholder="书名或作者"
            autoFocus={!initialKey}
            enterKeyHint="search"
            value={key}
            onChange={(change) => setKey(change.target.value)}
            className="flex-1 min-w-0 bg-transparent text-sm outline-none"
          />
          {key && (
            <button type="button" aria-label="清除" onClick={() => setKey("")}>
              <Icon name="close" size={15} className="text-secondary" />
            </button>
          )}
        </label>
        {running ? (
          <Button type="button" variant="outline" onClick={stop}>
            停止
          </Button>
        ) : (
          <Button type="submit" disabled={!key.trim()}>
            搜索
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
          精准搜索
        </button>
      </div>

      {event === null && history.length > 0 && (
        <section aria-label="搜索历史" className="space-y-2">
          <div className="flex items-center justify-between px-1 text-[11px] text-secondary">
            搜索历史
            <button
              type="button"
              onClick={() => {
                clearSearchHistory();
                setHistory([]);
              }}
            >
              清除
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
              ? `正在搜索 ${event.searched}/${event.total}`
              : `${event.total} 个书源，找到 ${event.results.length} 本`}
          </span>
        </div>
      )}

      {event?.done && event.results.length === 0 && (
        <p className="py-8 text-center text-sm text-secondary">
          {event.total === 0
            ? "没有可用于搜索的书源，先在书源管理里导入或启用书源。"
            : "没有找到。"}
        </p>
      )}

      <ul className="space-y-1.5" aria-label="搜索结果">
        {event?.results.map((result) => (
          <SearchResultRow
            key={`${result.name}\n${result.author}`}
            service={service}
            result={result}
            onOpen={() => setOpened(result)}
          />
        ))}
      </ul>

      {event && event.failures.length > 0 && event.done && (
        <details className="px-1 text-[11px] text-secondary">
          <summary>{event.failures.length} 个书源出错</summary>
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
        <OnlineBookPage service={service} result={opened} onClose={() => setOpened(null)} />
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
  onOpen,
}: {
  service: SourceService;
  result: OnlineSearchResult;
  onOpen: () => void;
}) {
  const first = result.origins[0];
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex gap-3 rounded-xl bg-surface-container-low p-2 text-left"
      >
        <span className="w-12 h-16 shrink-0 rounded overflow-hidden bg-surface-container">
          <OnlineCover
            service={service}
            sourceUrl={first?.sourceUrl ?? ""}
            url={result.coverUrl}
            title={result.name}
          />
        </span>
        <span className="flex-1 min-w-0 space-y-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{result.name}</span>
            {result.origins.length > 1 && (
              <span className="shrink-0 rounded-full bg-primary/10 text-primary text-[10px] px-1.5 leading-4">
                {result.origins.length} 个书源
              </span>
            )}
          </span>
          <span className="block text-[11px] text-secondary truncate">
            {[result.author, result.kind, result.wordCount].filter(Boolean).join(" · ")}
          </span>
          {result.latestChapterTitle && (
            <span className="block text-[11px] text-secondary truncate">
              最新：{result.latestChapterTitle}
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
          <DialogTitle className="font-title-editorial text-base">搜索范围</DialogTitle>
        </DialogHeader>
        <Button variant="outline" size="sm" onClick={() => onChoose(ALL_SOURCES)}>
          全部启用的书源
        </Button>
        {allGroups.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] text-secondary">分组（可多选）</p>
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
              搜索所选分组
            </Button>
          </div>
        )}
        <p className="text-[11px] text-secondary">单个书源</p>
        <input
          aria-label="筛选书源"
          placeholder="书源名称"
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
                {!source.enabled && <span className="ml-2 text-[11px] text-secondary">已禁用</span>}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

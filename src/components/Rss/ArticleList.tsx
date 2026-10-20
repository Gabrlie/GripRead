import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFeeds, useRuntime } from "../../application/runtime";
import { useT, type MessageKey } from "../../i18n";
import type { ArticleFilter, ArticleSummary } from "../../types/generated";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { useWindowedList } from "../ui/use-windowed-list";
import { useLongPress, type PressPoint } from "../ui/use-long-press";
import { articleTime, imageBlob } from "./format";

const FILTERS: [ArticleFilter, MessageKey][] = [
  ["all", "rss.filter.all"],
  ["unread", "rss.filter.unread"],
  ["starred", "rss.filter.starred"],
];

/** How long scrolled-past articles gather before they are marked read. */
const SCROLL_MARK_MS = 1000;
/** A row's height before it is measured (with the gap below it). */
export const ROW_ESTIMATE = 104;

/** The element that scrolls `element`, for watching rows leave its top. */
function scrollerOf(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * 划出屏幕时标为已读: unread rows (not kept unread) that scroll up past the
 * top of the list (`first` is the first row in view) are marked read a
 * moment later, together. They stay where they are, also under 未读, until
 * the list next loads.
 */
function useMarkOnScroll(first: number, articles: ArticleSummary[]) {
  const { state, store } = useFeeds();
  const on = state.settings?.markReadOnScroll === true;
  const pending = useRef(new Set<string>());
  const timer = useRef<number | null>(null);
  const passed = useRef(0);
  const list = useRef(articles);
  // A new list starts from its top.
  if (list.current !== articles && articles[0]?.id !== list.current[0]?.id) passed.current = 0;
  list.current = articles;
  const flush = useRef(() => undefined as void);
  flush.current = () => {
    timer.current = null;
    const ids = [...pending.current];
    pending.current.clear();
    if (ids.length) void store.setState(ids, { read: true }).catch(() => undefined);
  };
  useEffect(() => {
    if (!on) {
      passed.current = first;
      return;
    }
    if (first <= passed.current) return;
    for (const article of articles.slice(passed.current, first))
      if (!article.read && !article.keepUnread) pending.current.add(article.id);
    passed.current = first;
    if (pending.current.size && timer.current === null)
      timer.current = window.setTimeout(() => flush.current(), SCROLL_MARK_MS);
  }, [on, first, articles]);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        flush.current();
      }
    },
    [],
  );
}

/** An article's first picture, fetched through the app's cache once in view. */
function ArticleThumb({
  url,
  referer,
  dim,
}: {
  url: string;
  referer: string | null;
  dim: boolean;
}) {
  const service = useRuntime().services.feeds;
  const box = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let active = true;
    let made: string | null = null;
    const load = () =>
      void service.image(url, referer).then(
        (bytes) => {
          if (!active || bytes.byteLength === 0) return;
          made = URL.createObjectURL(imageBlob(bytes));
          setSource(made);
        },
        () => active && setFailed(true),
      );
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "undefined") load();
    else {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        load();
      });
      observer.observe(element);
    }
    return () => {
      active = false;
      observer?.disconnect();
      if (made) URL.revokeObjectURL(made);
    };
  }, [url, referer, service]);
  if (failed) return null;
  return (
    <span
      ref={box}
      aria-hidden="true"
      className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface-container ${
        dim ? "opacity-55" : ""
      }`}
    >
      {source && <img src={source} alt="" className="h-full w-full object-cover" />}
    </span>
  );
}

function ArticleRow({
  article,
  active,
  onOpen,
  onMenu,
  onMeasure,
}: {
  article: ArticleSummary;
  active: boolean;
  onOpen: () => void;
  onMenu: (point: PressPoint) => void;
  /** The row's height as laid out, gap included. */
  onMeasure: (height: number) => void;
}) {
  const t = useT();
  const { state } = useFeeds();
  const press = useLongPress(onMenu, onOpen);
  const measure = useRef(onMeasure);
  measure.current = onMeasure;
  const row = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const report = () => element.offsetHeight > 0 && measure.current(element.offsetHeight);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <li ref={row} data-article={article.id} className="pb-2">
      <button
        type="button"
        aria-current={active || undefined}
        className={`w-full text-left rounded-xl px-3.5 py-3 flex gap-3 ${
          active ? "bg-surface-container" : "bg-surface-container-low"
        }`}
        {...press}
      >
        <span className="flex-1 min-w-0 space-y-1">
          <span className="flex items-center gap-1.5 text-[11px] text-secondary">
            {!article.read && (
              <span
                aria-label={t("rss.unread")}
                className="h-1.5 w-1.5 rounded-full bg-primary shrink-0"
              />
            )}
            <span className="truncate">{article.feedTitle}</span>
            <span className="shrink-0">· {articleTime(article.publishedAt)}</span>
            {article.starred && (
              <Icon name="star" size={11} className="text-primary fill-current shrink-0" />
            )}
            {article.keepUnread && (
              <Icon
                name="push_pin"
                size={11}
                className="text-primary shrink-0"
                aria-label={t("rss.keptUnread")}
              />
            )}
          </span>
          <span
            className={`block font-title-editorial text-sm leading-snug line-clamp-2 ${
              article.read ? "text-secondary font-normal" : "text-on-surface font-semibold"
            }`}
          >
            {article.title}
          </span>
          {article.excerpt && (
            <span
              className={`block text-xs text-secondary line-clamp-2 ${
                article.read ? "opacity-55" : ""
              }`}
            >
              {article.excerpt}
            </span>
          )}
        </span>
        {article.image && state.settings?.listImages !== false && (
          <ArticleThumb url={article.image} referer={article.link} dim={article.read} />
        )}
      </button>
    </li>
  );
}

/**
 * The chosen list's articles, newest first, with 全部 / 未读 / 星标, search,
 * and more as the end comes into view; only the rows near the view are
 * made, so long lists stay quick. A long press or right-click opens
 * an article's menu there. Read articles are dimmed.
 */
export function ArticleList({
  activeId,
  onOpen,
  onMenu,
}: {
  activeId: string | null;
  onOpen: (article: ArticleSummary) => void;
  onMenu: (article: ArticleSummary, point: PressPoint) => void;
}) {
  const t = useT();
  const { state, store } = useFeeds();
  const [search, setSearch] = useState(state.search);
  const end = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    scroller.current = scrollerOf(rows.current);
  }, []);
  // Heights of rows laid out so far; the others are estimated.
  const [heights, setHeights] = useState(() => new Map<string, number>());
  const measured = useRef(new Map<string, number>());
  const frame = useRef(0);
  const articles = state.articles;
  const heightOf = useCallback(
    (index: number) => heights.get(articles[index]?.id) ?? ROW_ESTIMATE,
    [heights, articles],
  );
  const measure = useCallback((id: string, height: number) => {
    if (Math.abs((measured.current.get(id) ?? 0) - height) < 1) return;
    measured.current.set(id, height);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setHeights(new Map(measured.current)));
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const windowed = useWindowedList(scroller, articles.length, heightOf, rows);
  useMarkOnScroll(windowed.first, articles);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search !== state.search) store.setSearch(search);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const marker = end.current;
    if (!marker || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void store.loadMore();
    });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [store]);
  return (
    <section aria-label={t("rss.articleList")} className="space-y-2">
      <div className="flex items-center gap-2">
        <div
          role="tablist"
          aria-label={t("rss.filter")}
          className="flex gap-1 bg-surface-container p-0.5 rounded-lg"
        >
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={state.filter === value}
              className={`h-7 px-2.5 rounded-md text-xs ${
                state.filter === value
                  ? "bg-surface text-primary font-semibold shadow-xs"
                  : "text-secondary"
              }`}
              onClick={() => store.setFilter(value)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <Input
          aria-label={t("rss.search")}
          placeholder={t("rss.search.placeholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-8 flex-1 min-w-0 text-xs"
        />
      </div>
      {state.error && (
        <p role="alert" className="text-xs text-error px-1">
          {state.error}
        </p>
      )}
      {state.loading && !state.articles.length ? (
        <p role="status" className="py-10 text-center text-xs text-secondary">
          {t("rss.loadingArticles")}
        </p>
      ) : state.articles.length === 0 ? (
        <p className="py-10 text-center text-sm text-secondary">
          {state.filter === "unread"
            ? t("rss.noUnread")
            : state.filter === "starred"
              ? t("rss.noStarred")
              : state.search
                ? t("rss.notFound")
                : t("rss.noArticles")}
        </p>
      ) : null}
      {/* Only the rows near the view are made; spacers stand for the rest. */}
      <ul
        ref={rows}
        style={{ paddingTop: windowed.before, paddingBottom: windowed.after }}
        hidden={state.articles.length === 0}
      >
        {articles.slice(windowed.start, windowed.end).map((article) => (
          <ArticleRow
            key={article.id}
            article={article}
            active={article.id === activeId}
            onOpen={() => onOpen(article)}
            onMenu={(point) => onMenu(article, point)}
            onMeasure={(height) => measure(article.id, height)}
          />
        ))}
      </ul>
      <div ref={end} aria-hidden="true" className="h-4" />
      {state.loadingMore && (
        <p role="status" className="text-center text-xs text-secondary">
          {t("rss.loadingMore")}
        </p>
      )}
    </section>
  );
}

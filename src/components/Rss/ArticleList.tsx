import { useEffect, useRef, useState, type RefObject } from "react";
import { useFeeds, useRuntime } from "../../application/runtime";
import { useT, type MessageKey } from "../../i18n";
import type { ArticleFilter, ArticleSummary } from "../../types/generated";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { useLongPress, type PressPoint } from "../ui/use-long-press";
import { articleTime, imageBlob } from "./format";

const FILTERS: [ArticleFilter, MessageKey][] = [
  ["all", "rss.filter.all"],
  ["unread", "rss.filter.unread"],
  ["starred", "rss.filter.starred"],
];

/** How long scrolled-past articles gather before they are marked read. */
const SCROLL_MARK_MS = 1000;

/** The element that scrolls `element`, for watching rows leave its top. */
function scrollerOf(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * 划出屏幕时标为已读: unread rows (not kept unread) that scroll up out of
 * the list are marked read a moment later, together. They stay where they
 * are, also under 未读, until the list next loads.
 */
function useMarkOnScroll(list: RefObject<HTMLElement | null>, articles: ArticleSummary[]) {
  const { state, store } = useFeeds();
  const on = state.settings?.markReadOnScroll === true;
  const pending = useRef(new Set<string>());
  const timer = useRef<number | null>(null);
  const known = useRef(articles);
  known.current = articles;
  useEffect(() => {
    const element = list.current;
    if (!on || !element || typeof IntersectionObserver === "undefined") return;
    const flush = () => {
      timer.current = null;
      const ids = [...pending.current];
      pending.current.clear();
      if (ids.length) void store.setState(ids, { read: true }).catch(() => undefined);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const top = entry.rootBounds?.top ?? 0;
          if (entry.isIntersecting || entry.boundingClientRect.bottom > top + 1) continue;
          const id = (entry.target as HTMLElement).dataset.article;
          const article = known.current.find((item) => item.id === id);
          if (!article || article.read || article.keepUnread) continue;
          pending.current.add(article.id);
        }
        if (pending.current.size && timer.current === null)
          timer.current = window.setTimeout(flush, SCROLL_MARK_MS);
      },
      { root: scrollerOf(element) },
    );
    element.querySelectorAll("[data-article]").forEach((row) => observer.observe(row));
    return () => {
      observer.disconnect();
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        flush();
      }
    };
  }, [on, articles, store, list]);
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
}: {
  article: ArticleSummary;
  active: boolean;
  onOpen: () => void;
  onMenu: (point: PressPoint) => void;
}) {
  const t = useT();
  const { state } = useFeeds();
  const press = useLongPress(onMenu, onOpen);
  return (
    <li data-article={article.id}>
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
 * and more as the end comes into view. A long press or right-click opens
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
  useMarkOnScroll(rows, state.articles);
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
      ) : (
        <ul ref={rows} className="space-y-2">
          {state.articles.map((article) => (
            <ArticleRow
              key={article.id}
              article={article}
              active={article.id === activeId}
              onOpen={() => onOpen(article)}
              onMenu={(point) => onMenu(article, point)}
            />
          ))}
        </ul>
      )}
      <div ref={end} aria-hidden="true" className="h-4" />
      {state.loadingMore && (
        <p role="status" className="text-center text-xs text-secondary">
          {t("rss.loadingMore")}
        </p>
      )}
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { useFeeds } from "../../application/runtime";
import type { ArticleFilter, ArticleSummary } from "../../types/generated";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { useLongPress } from "../ui/use-long-press";
import { articleTime } from "./format";

const FILTERS: [ArticleFilter, string][] = [
  ["all", "全部"],
  ["unread", "未读"],
  ["starred", "星标"],
];

function ArticleRow({
  article,
  active,
  onOpen,
  onMenu,
}: {
  article: ArticleSummary;
  active: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const press = useLongPress(onMenu, onOpen);
  return (
    <li>
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
              <span aria-label="未读" className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
            )}
            <span className="truncate">{article.feedTitle}</span>
            <span className="shrink-0">· {articleTime(article.publishedAt)}</span>
            {article.starred && (
              <Icon name="star" size={11} className="text-primary fill-current shrink-0" />
            )}
          </span>
          <span
            className={`block font-title-editorial text-sm leading-snug line-clamp-2 ${
              article.read ? "text-secondary" : "text-on-surface font-semibold"
            }`}
          >
            {article.title}
          </span>
          {article.excerpt && (
            <span className="block text-xs text-secondary line-clamp-2">{article.excerpt}</span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * The chosen list's articles, newest first, with 全部 / 未读 / 星标, search,
 * and more as the end comes into view. A long press or right-click opens
 * an article's menu.
 */
export function ArticleList({
  activeId,
  onOpen,
  onMenu,
}: {
  activeId: string | null;
  onOpen: (article: ArticleSummary) => void;
  onMenu: (article: ArticleSummary) => void;
}) {
  const { state, store } = useFeeds();
  const [search, setSearch] = useState(state.search);
  const end = useRef<HTMLDivElement>(null);
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
    <section aria-label="文章列表" className="space-y-2">
      <div className="flex items-center gap-2">
        <div
          role="tablist"
          aria-label="文章筛选"
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
              {label}
            </button>
          ))}
        </div>
        <Input
          aria-label="搜索文章"
          placeholder="搜索标题和摘要"
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
          正在读取文章…
        </p>
      ) : state.articles.length === 0 ? (
        <p className="py-10 text-center text-sm text-secondary">
          {state.filter === "unread"
            ? "没有未读文章"
            : state.filter === "starred"
              ? "还没有星标文章"
              : state.search
                ? "没有找到文章"
                : "还没有文章，下拉或点刷新获取"}
        </p>
      ) : (
        <ul className="space-y-2">
          {state.articles.map((article) => (
            <ArticleRow
              key={article.id}
              article={article}
              active={article.id === activeId}
              onOpen={() => onOpen(article)}
              onMenu={() => onMenu(article)}
            />
          ))}
        </ul>
      )}
      <div ref={end} aria-hidden="true" className="h-4" />
      {state.loadingMore && (
        <p role="status" className="text-center text-xs text-secondary">
          正在读取更多…
        </p>
      )}
    </section>
  );
}

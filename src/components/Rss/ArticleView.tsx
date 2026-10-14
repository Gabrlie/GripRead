import { useEffect, useState } from "react";
import { useFeeds, useRuntime } from "../../application/runtime";
import { openExternal } from "../../services/external";
import type { Article } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { ArticleContent } from "./ArticleContent";
import { articleTime } from "./format";

/**
 * One article, scrolling as a whole: title, feed, time, author, then the
 * feed's text, or the page's 全文 once fetched. Bars give 原文, 全文,
 * star, unread, and the neighbouring articles of the list.
 */
export function ArticleView({
  id,
  onOpen,
}: {
  id: string;
  /** Opens another article of the list (上一篇 / 下一篇). */
  onOpen: (id: string) => void;
}) {
  const service = useRuntime().services.feeds;
  const { state, store } = useFeeds();
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [fetching, setFetching] = useState(false);
  const summary = state.articles.find((item) => item.id === id) ?? article?.summary ?? null;

  useEffect(() => {
    let active = true;
    setArticle(null);
    setError(null);
    setFull(false);
    void service.getArticle(id).then(
      (loaded) => {
        if (!active) return;
        setArticle(loaded);
        setFull(Boolean(loaded.fullText));
        if (!loaded.summary.read && state.settings?.markReadOnOpen !== false)
          void store.setState([id], { read: true }).catch(() => undefined);
      },
      (failure: unknown) => active && setError(describeError(failure)),
    );
    return () => {
      active = false;
    };
    // Opening an article reads it once; later state changes do not reload.
  }, [id, service]);

  const fetchFull = () => {
    if (article?.fullText) {
      setFull(true);
      return;
    }
    setFetching(true);
    void service
      .fetchFullText(id)
      .then(
        (fullText) => {
          setArticle((current) => (current ? { ...current, fullText } : current));
          setFull(true);
        },
        (failure: unknown) => toast({ text: describeError(failure), error: true }),
      )
      .finally(() => setFetching(false));
  };

  const index = state.articles.findIndex((item) => item.id === id);
  const previous = index > 0 ? state.articles[index - 1] : null;
  const next = index >= 0 ? state.articles[index + 1] : null;
  if (index >= 0 && index >= state.articles.length - 3) void store.loadMore();

  if (error)
    return (
      <p role="alert" className="p-6 text-sm text-error">
        {error}
      </p>
    );
  if (!article || !summary)
    return (
      <p role="status" className="p-6 text-sm text-secondary">
        正在读取…
      </p>
    );

  const html = full && article.fullText ? article.fullText : article.content;
  return (
    <article aria-label={summary.title} className="flex flex-col min-h-full">
      <div className="flex-1 px-5 py-5 max-w-2xl mx-auto w-full">
        <h1
          className="font-title-editorial text-xl font-semibold leading-snug"
          data-selectable="true"
        >
          {summary.title}
        </h1>
        <p className="mt-2 text-xs text-secondary">
          {[summary.feedTitle, articleTime(summary.publishedAt), summary.author]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="mt-5">
          {html.trim() ? (
            <ArticleContent
              html={html}
              referer={summary.link}
              service={service}
              fontSize={state.settings?.fontSize ?? 17}
            />
          ) : (
            <p className="text-sm text-secondary">这篇文章没有正文，可以读取全文或打开原文。</p>
          )}
        </div>
      </div>
      <div className="sticky bottom-0 border-t border-surface-variant/30 bg-surface/95 backdrop-blur pb-safe">
        <div className="max-w-2xl mx-auto flex items-center gap-1 px-2 h-12">
          <Button
            size="icon"
            variant="ghost"
            aria-label="上一篇"
            disabled={!previous}
            onClick={() => previous && onOpen(previous.id)}
          >
            <Icon name="chevron_left" size={20} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="下一篇"
            disabled={!next}
            onClick={() => next && onOpen(next.id)}
          >
            <Icon name="chevron_right" size={20} />
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={full}
            disabled={fetching || (!summary.link && !article.fullText)}
            onClick={() => (full ? setFull(false) : fetchFull())}
          >
            {fetching ? "正在读取…" : full ? "显示摘要" : "全文"}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={summary.read ? "标为未读" : "标为已读"}
            onClick={() =>
              void store.setState([id], { read: !summary.read }).catch(() => undefined)
            }
          >
            <Icon name={summary.read ? "mark_unread" : "mark_read"} size={18} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={summary.starred ? "取消星标" : "星标"}
            aria-pressed={summary.starred}
            className={summary.starred ? "text-primary" : ""}
            onClick={() =>
              void store.setState([id], { starred: !summary.starred }).catch(() => undefined)
            }
          >
            <Icon name="star" size={18} className={summary.starred ? "fill-current" : ""} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="打开原文"
            disabled={!summary.link}
            onClick={() => summary.link && void openExternal(summary.link).catch(() => undefined)}
          >
            <Icon name="open_in_new" size={18} />
          </Button>
        </div>
      </div>
    </article>
  );
}

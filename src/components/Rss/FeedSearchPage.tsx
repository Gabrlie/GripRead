import { useEffect, useState } from "react";
import { useFeeds, useRuntime } from "../../application/runtime";
import { useT, type MessageKey } from "../../i18n";
import type { FeedPreview, FeedSearchResult, FeedSearchSource } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import { ArticleContent } from "./ArticleContent";
import { feedGroupNames } from "../../application/rss";
import { Choice, GroupField } from "./controls";
import { articleTime, hostOf } from "./format";

const SOURCES: Record<FeedSearchSource, MessageKey> = {
  feed: "rss.find.source.feed",
  page: "rss.find.source.page",
  rsshub: "rss.find.source.rsshub",
  feedly: "rss.find.source.feedly",
};

/**
 * Subscribing to a feed found: its name (the feed's own when empty), its
 * group, and, with 订阅账号, where: on this device or on an account.
 */
function SubscribeDialog({
  url,
  title: found,
  onDone,
  onClose,
}: {
  url: string;
  title: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { state, store } = useFeeds();
  const [title, setTitle] = useState(found);
  const [group, setGroup] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const subscribe = () => {
    setBusy(true);
    void store
      .addFeed(url, title.trim() || null, group.trim() || null, account)
      .then(
        (feed) => {
          toast(t("rss.subscribed", { title: feed.title }));
          onDone();
        },
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">{t("rss.subscribe")}</DialogTitle>
          <p className="text-[11px] text-secondary break-all">{url}</p>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) subscribe();
          }}
        >
          <Input
            aria-label={t("rss.name")}
            placeholder={t("rss.name.placeholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          {state.accounts.length > 0 && (
            <div className="-mx-4 -my-3">
              <Choice<string | null>
                label={t("rss.account.target")}
                options={[
                  [null, t("rss.account.local")],
                  ...state.accounts.map((item): [string, string] => [item.id, item.name]),
                ]}
                value={account}
                onPick={(picked) => {
                  setAccount(picked);
                  setGroup("");
                }}
              />
            </div>
          )}
          <div className="space-y-1">
            <GroupField
              id="rss-subscribe-groups"
              value={group}
              onChange={setGroup}
              groups={feedGroupNames(state, account)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? t("rss.subscribing") : t("rss.subscribe")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A feed read before subscribing: its newest articles (kept nowhere), each
 * opening in place, and 订阅.
 */
export function FeedPreviewPage({
  result,
  onClose,
  onSubscribed,
}: {
  result: FeedSearchResult;
  onClose: () => void;
  onSubscribed: () => void;
}) {
  const t = useT();
  const service = useRuntime().services.feeds;
  const { state } = useFeeds();
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const subscribed = state.feeds.some(
    (feed) => feed.url === result.url || feed.address === result.url,
  );
  useEffect(() => {
    let active = true;
    void service.preview(result.url).then(
      (loaded) => active && setPreview(loaded),
      (failure: unknown) => active && setError(describeError(failure)),
    );
    return () => {
      active = false;
    };
  }, [service, result.url]);
  const article = preview?.articles.find((item) => item.id === open) ?? null;
  return (
    <FullPage
      label={preview?.title ?? result.title}
      onClose={onClose}
      layer="z-[55]"
      actions={
        <Button
          size="sm"
          disabled={subscribed}
          onClick={() => setSubscribing(true)}
          className="h-8 px-3 text-xs"
        >
          {subscribed ? t("rss.find.subscribed") : t("rss.subscribe")}
        </Button>
      }
    >
      <p className="px-1 text-xs text-secondary break-all">{result.url}</p>
      <p className="px-1 text-[11px] text-secondary">{t("rss.preview.note")}</p>
      {error && (
        <p role="alert" className="px-1 text-sm text-error break-all">
          {error}
        </p>
      )}
      {!preview && !error && (
        <p role="status" className="px-1 text-sm text-secondary">
          {t("rss.preview.loading")}
        </p>
      )}
      {preview && (
        <PageSection>
          {preview.articles.length === 0 && (
            <p className="px-4 py-3 text-sm text-secondary">{t("rss.preview.empty")}</p>
          )}
          {preview.articles.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setOpen(item.id)}
              className="w-full px-4 py-3 text-left hover:bg-surface-container transition-colors"
            >
              <span className="block text-sm font-medium leading-snug line-clamp-2">
                {item.title}
              </span>
              <span className="block text-[11px] text-secondary mt-0.5">
                {articleTime(item.publishedAt)}
                {item.author ? ` · ${item.author}` : ""}
              </span>
              {item.excerpt && (
                <span className="block text-xs text-secondary mt-1 line-clamp-2">
                  {item.excerpt}
                </span>
              )}
            </button>
          ))}
        </PageSection>
      )}
      {article && (
        <FullPage label={article.title} onClose={() => setOpen(null)} layer="z-[60]">
          <article className="px-2 space-y-3">
            <h2 className="font-title-editorial text-xl font-semibold leading-snug">
              {article.title}
            </h2>
            <p className="text-xs text-secondary">
              {preview?.title} · {articleTime(article.publishedAt)}
              {article.author ? ` · ${article.author}` : ""}
            </p>
            <ArticleContent
              html={article.content || article.excerpt}
              referer={article.link}
              service={service}
              fontSize={state.settings?.fontSize ?? 17}
            />
          </article>
        </FullPage>
      )}
      {subscribing && (
        <SubscribeDialog
          url={result.url}
          title={preview?.title ?? result.title}
          onClose={() => setSubscribing(false)}
          onDone={() => {
            setSubscribing(false);
            onSubscribed();
          }}
        />
      )}
    </FullPage>
  );
}

/**
 * 添加订阅 as a search: words look in Feedly's directory; an address finds
 * the feed itself, the feeds its page names, and RSSHub routes for it.
 * Any result opens a preview to read before subscribing.
 */
export function FeedSearchPage({
  onClose,
  layer = "z-50",
}: {
  onClose: () => void;
  layer?: string;
}) {
  const t = useT();
  const service = useRuntime().services.feeds;
  const { state } = useFeeds();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FeedSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<FeedSearchResult | null>(null);
  const subscribed = new Set(state.feeds.map((feed) => feed.address ?? feed.url));
  const search = () => {
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    void service
      .search(text)
      .then(setResults, (failure: unknown) => {
        setResults(null);
        setError(describeError(failure));
      })
      .finally(() => setBusy(false));
  };
  return (
    <FullPage label={t("rss.add")} onClose={onClose} layer={layer}>
      <form
        className="flex gap-2 px-1"
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <Input
          autoFocus
          type="search"
          enterKeyHint="search"
          autoCapitalize="none"
          aria-label={t("rss.find.placeholder")}
          placeholder={t("rss.find.placeholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || !query.trim()} className="shrink-0">
          {busy ? t("rss.find.searching") : t("rss.find.go")}
        </Button>
      </form>
      {!results && !error && (
        <p className="px-1 text-[11px] text-secondary">{t("rss.find.note")}</p>
      )}
      {error && (
        <p role="alert" className="px-1 text-sm text-error break-all">
          {error}
        </p>
      )}
      {results && (
        <PageSection>
          {results.length === 0 && (
            <p className="px-4 py-3 text-sm text-secondary">{t("rss.find.empty")}</p>
          )}
          {results.map((result) => (
            <button
              key={result.url}
              type="button"
              aria-label={t("rss.preview.open", { title: result.title })}
              onClick={() => setChosen(result)}
              className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-surface-container transition-colors"
            >
              <Icon name="rss_feed" size={18} className="text-primary shrink-0 mt-0.5" />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="text-sm font-medium truncate">{result.title}</span>
                  <span className="shrink-0 rounded-full bg-surface-container px-1.5 py-px text-[10px] text-secondary">
                    {t(SOURCES[result.source])}
                  </span>
                </span>
                <span className="block text-[11px] text-secondary truncate">
                  {[
                    result.site ? hostOf(result.site) : hostOf(result.url),
                    result.subscribers !== null
                      ? t("rss.find.subscribers", { count: result.subscribers })
                      : null,
                    subscribed.has(result.url) ? t("rss.find.subscribed") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {result.description && (
                  <span className="block text-xs text-secondary mt-0.5 line-clamp-2 break-all">
                    {result.description}
                  </span>
                )}
              </span>
              <Icon name="chevron_right" size={16} className="text-outline-variant shrink-0" />
            </button>
          ))}
        </PageSection>
      )}
      {chosen && (
        <FeedPreviewPage
          result={chosen}
          onClose={() => setChosen(null)}
          onSubscribed={() => setChosen(null)}
        />
      )}
    </FullPage>
  );
}

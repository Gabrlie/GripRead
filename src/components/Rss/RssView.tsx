import { useEffect, useRef, useState } from "react";
import { selectionTitle, type FeedSelection } from "../../application/rss";
import { useFeeds } from "../../application/runtime";
import { openExternal } from "../../services/external";
import type { ArticleSummary } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { Header } from "../Layout/Header";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { PULL_TRIGGER, usePullRefresh } from "../ui/use-pull-refresh";
import { AddFeedDialog } from "./AddFeedDialog";
import { ArticleList } from "./ArticleList";
import { ArticleView } from "./ArticleView";
import { FeedList } from "./FeedList";
import { FeedManagePage } from "./FeedManagePage";
import { useWide } from "./use-wide";
import { RssSettingsPage } from "./RssSettingsPage";
import { useT } from "../../i18n";

function ArticleMenu({ article, onClose }: { article: ArticleSummary; onClose: () => void }) {
  const t = useT();
  const { store } = useFeeds();
  const act = (work: () => Promise<unknown>) => {
    onClose();
    void work().catch((error: unknown) => toast({ text: describeError(error), error: true }));
  };
  const item =
    "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-surface-container";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-3 gap-1">
        <DialogHeader className="px-2 pt-1">
          <DialogTitle className="text-sm line-clamp-2">{article.title}</DialogTitle>
        </DialogHeader>
        <button
          type="button"
          className={item}
          onClick={() => act(() => store.setState([article.id], { read: !article.read }))}
        >
          <Icon name={article.read ? "mark_unread" : "mark_read"} size={17} />
          {article.read ? t("rss.markUnread") : t("rss.markRead")}
        </button>
        <button
          type="button"
          className={item}
          onClick={() => act(() => store.setState([article.id], { starred: !article.starred }))}
        >
          <Icon name="star" size={17} />
          {article.starred ? t("rss.unstar") : t("rss.star")}
        </button>
        {article.link && (
          <button
            type="button"
            className={item}
            onClick={() => act(() => openExternal(article.link!))}
          >
            <Icon name="open_in_new" size={17} />
            {t("rss.openLink")}
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 订阅. On a phone: the subscriptions, then a list's articles, then an
 * article, each over the last. On a wide screen: the three side by side,
 * keeping the selection.
 */
export function RssView() {
  const t = useT();
  const { state, store } = useFeeds();
  const wide = useWide();
  // On a phone the article list is open; on a wide screen it always shows.
  const [listOpen, setListOpen] = useState(false);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ArticleSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [setting, setSetting] = useState(false);
  const [confirmRead, setConfirmRead] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const pull = usePullRefresh(content, () => void store.refresh(), !wide);

  useEffect(() => {
    void store.enter();
  }, [store]);

  const select = (selection: FeedSelection) => {
    store.select(selection);
    setArticleId(null);
    if (!wide) setListOpen(true);
  };
  const markAllRead = () =>
    void store.markAllRead().then(
      (count) => toast(count ? t("rss.markedRead", { count }) : t("rss.noUnread")),
      (error: unknown) => toast({ text: describeError(error), error: true }),
    );
  const title = selectionTitle(state.selection, state.feeds);
  const refreshing = state.refreshing ? t("rss.refreshing", state.refreshing) : null;
  const listActions = (
    <>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("rss.refresh")}
        disabled={state.refreshing !== null}
        onClick={() => void store.refresh()}
      >
        <Icon name="refresh" size={18} className={state.refreshing ? "animate-spin" : ""} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("rss.markAllRead")}
        onClick={() => setConfirmRead(true)}
      >
        <Icon name="done_all" size={18} />
      </Button>
    </>
  );
  const list = (
    <ArticleList
      activeId={articleId}
      onOpen={(article) => setArticleId(article.id)}
      onMenu={setMenu}
    />
  );

  return (
    <div className="flex-1 flex flex-col relative w-full pt-[calc(3.5rem+var(--safe-top))] pb-[calc(5rem+var(--safe-bottom))] md:pb-0 md:h-screen md:max-h-screen md:min-h-0 md:overflow-hidden bg-surface min-w-0">
      <Header
        title={t("nav.feeds")}
        subtitle="FEEDS"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="flex items-center gap-1 bg-surface-container text-primary h-8 px-2.5 rounded-lg border-transparent mr-1"
            onClick={() => setAdding(true)}
          >
            <Icon name="add" size={16} />
            <span className="text-xs">{t("rss.add")}</span>
          </Button>
        }
        menuItems={[
          { icon: "refresh", label: t("rss.refreshAll"), onSelect: () => void store.refresh() },
          { icon: "done_all", label: t("rss.markAllRead"), onSelect: () => setConfirmRead(true) },
          { icon: "tune", label: t("rss.manage"), onSelect: () => setManaging(true) },
          { icon: "settings", label: t("rss.settings"), onSelect: () => setSetting(true) },
        ]}
      />
      {(refreshing || state.failed > 0) && (
        <p role="status" className="px-4 md:px-8 pt-2 text-[11px] text-secondary">
          {refreshing ?? t("rss.lastFailed", { count: state.failed })}
        </p>
      )}
      {!wide && (
        <div
          role="status"
          aria-hidden={!pull.distance}
          className="fixed left-0 right-0 z-20 flex justify-center pointer-events-none top-[calc(4rem+var(--safe-top))]"
          style={{
            opacity: Math.min(1, pull.distance / PULL_TRIGGER),
            transform: `translateY(${Math.max(0, pull.distance / 2 - 14)}px)`,
            transition: pull.dragging ? "none" : "opacity 200ms ease-out, transform 300ms ease-out",
          }}
        >
          <span className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1.5 text-xs text-secondary shadow-sm">
            <Icon
              name="refresh"
              size={14}
              style={{ transform: `rotate(${pull.distance * 4}deg)` }}
            />
            {pull.distance >= PULL_TRIGGER ? t("rss.pull.release") : t("rss.pull.hint")}
          </span>
        </div>
      )}
      {wide ? (
        <div className="flex-1 min-h-0 grid grid-cols-[15rem_22rem_1fr]">
          <aside className="overflow-y-auto border-r border-surface-variant/30 p-3">
            <FeedList feeds={state.feeds} selection={state.selection} onSelect={select} />
          </aside>
          <section
            aria-label={title}
            className="overflow-y-auto border-r border-surface-variant/30 p-3 space-y-2"
          >
            <div className="flex items-center gap-1">
              <h2 className="flex-1 min-w-0 truncate font-title-editorial text-sm font-semibold">
                {title}
              </h2>
              {listActions}
            </div>
            {list}
          </section>
          <section className="overflow-y-auto">
            {articleId ? (
              <ArticleView id={articleId} onOpen={setArticleId} />
            ) : (
              <p className="p-10 text-center text-sm text-secondary">{t("rss.pickArticle")}</p>
            )}
          </section>
        </div>
      ) : (
        <div
          ref={content}
          className="px-4 pt-3"
          style={{
            transform: pull.distance ? `translateY(${pull.distance}px)` : undefined,
            transition: pull.dragging ? "none" : "transform 300ms ease-out",
          }}
        >
          {state.feedsLoaded && state.feeds.length === 0 ? (
            <div className="rounded-2xl bg-surface-container-low p-8 text-center space-y-3 mt-4">
              <Icon name="rss_feed" size={28} className="mx-auto text-secondary" />
              <p className="text-sm">{t("rss.empty")}</p>
              <div className="flex justify-center gap-2">
                <Button size="sm" onClick={() => setAdding(true)}>
                  {t("rss.add")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setManaging(true)}>
                  {t("rss.importOpml")}
                </Button>
              </div>
            </div>
          ) : (
            <FeedList feeds={state.feeds} selection={state.selection} onSelect={select} />
          )}
        </div>
      )}
      {!wide && listOpen && (
        <FullPage label={title} onClose={() => setListOpen(false)} actions={listActions}>
          {list}
        </FullPage>
      )}
      {!wide && articleId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("rss.article")}
          className="fixed inset-0 z-[45] bg-surface flex flex-col pt-safe"
        >
          <header className="shrink-0 h-12 flex items-center px-2 border-b border-surface-variant/30">
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("common.back")}
              onClick={() => setArticleId(null)}
            >
              <Icon name="arrow_back" size={20} />
            </Button>
            <span className="flex-1 min-w-0 truncate text-sm text-secondary">{title}</span>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <ArticleView id={articleId} onOpen={setArticleId} />
          </div>
        </div>
      )}
      {menu && <ArticleMenu article={menu} onClose={() => setMenu(null)} />}
      {adding && <AddFeedDialog onClose={() => setAdding(false)} />}
      {managing && <FeedManagePage onClose={() => setManaging(false)} />}
      {setting && <RssSettingsPage onClose={() => setSetting(false)} />}
      {confirmRead && (
        <Dialog open onOpenChange={(open) => !open && setConfirmRead(false)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("rss.markAllRead")}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">{t("rss.markAllRead.confirm", { title })}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmRead(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setConfirmRead(false);
                  markAllRead();
                }}
              >
                {t("common.confirm")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

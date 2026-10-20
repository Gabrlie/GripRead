import { useEffect, useRef, useState, type ReactNode } from "react";
import { selectionTitle, type FeedSelection } from "../../application/rss";
import { useFeeds } from "../../application/runtime";
import type { ArticleSummary } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { Header } from "../Layout/Header";
import { FullPage } from "../Layout/FullPage";
import { usePageLayer } from "../Layout/use-page-layer";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { PULL_TRIGGER, usePullRefresh } from "../ui/use-pull-refresh";
import type { PressPoint } from "../ui/use-long-press";
import { AddFeedDialog } from "./AddFeedDialog";
import { ArticleList } from "./ArticleList";
import { ArticleMenu } from "./ArticleMenu";
import { FeedDetailPage } from "./FeedDetailPage";
import { ArticleView } from "./ArticleView";
import { FeedList } from "./FeedList";
import { FeedManagePage } from "./FeedManagePage";
import { useWide } from "./use-wide";
import { RssSettingsPage } from "./RssSettingsPage";
import { useT } from "../../i18n";

/**
 * An article on a phone, over its list: a bar with back and the list's
 * title, the article scrolling under it. Back (the button, Escape, or the
 * system gesture) closes it like any page.
 */
function ArticlePage({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const page = usePageLayer(onClose);
  return (
    <div
      ref={page}
      role="dialog"
      aria-modal="true"
      aria-label={t("rss.article")}
      data-open=""
      className="fixed inset-0 z-[45] bg-surface flex flex-col pt-safe"
    >
      <header className="shrink-0 h-12 flex items-center px-2 border-b border-surface-variant/30">
        <Button size="icon" variant="ghost" aria-label={t("common.back")} onClick={onClose}>
          <Icon name="arrow_back" size={20} />
        </Button>
        <span className="flex-1 min-w-0 truncate text-sm text-secondary">{title}</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </div>
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
  const [menu, setMenu] = useState<{ article: ArticleSummary; point: PressPoint } | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
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
      onMenu={(article, point) => setMenu({ article, point })}
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
            <FeedList
              feeds={state.feeds}
              groups={state.groups}
              selection={state.selection}
              onSelect={select}
              onDetail={setDetail}
            />
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
            <FeedList
              feeds={state.feeds}
              groups={state.groups}
              selection={state.selection}
              onSelect={select}
              onDetail={setDetail}
            />
          )}
        </div>
      )}
      {!wide && listOpen && (
        <FullPage label={title} onClose={() => setListOpen(false)} actions={listActions}>
          {list}
        </FullPage>
      )}
      {/* A page layer of its own, so back closes the article before the list. */}
      {!wide && articleId && (
        <ArticlePage title={title} onClose={() => setArticleId(null)}>
          <ArticleView id={articleId} onOpen={setArticleId} />
        </ArticlePage>
      )}
      {menu && (
        <ArticleMenu article={menu.article} point={menu.point} onClose={() => setMenu(null)} />
      )}
      {detail && <FeedDetailPage url={detail} onClose={() => setDetail(null)} />}
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

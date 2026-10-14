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

function ArticleMenu({ article, onClose }: { article: ArticleSummary; onClose: () => void }) {
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
          {article.read ? "标为未读" : "标为已读"}
        </button>
        <button
          type="button"
          className={item}
          onClick={() => act(() => store.setState([article.id], { starred: !article.starred }))}
        >
          <Icon name="star" size={17} />
          {article.starred ? "取消星标" : "星标"}
        </button>
        {article.link && (
          <button
            type="button"
            className={item}
            onClick={() => act(() => openExternal(article.link!))}
          >
            <Icon name="open_in_new" size={17} />
            打开原文
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
  const { state, store } = useFeeds();
  const wide = useWide();
  // On a phone the article list is open; on a wide screen it always shows.
  const [listOpen, setListOpen] = useState(false);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ArticleSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
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
      (count) => toast(count ? `${count} 篇标为已读` : "没有未读文章"),
      (error: unknown) => toast({ text: describeError(error), error: true }),
    );
  const title = selectionTitle(state.selection, state.feeds);
  const refreshing = state.refreshing
    ? `正在刷新 ${state.refreshing.done}/${state.refreshing.total}`
    : null;
  const listActions = (
    <>
      <Button
        size="icon"
        variant="ghost"
        aria-label="刷新订阅"
        disabled={state.refreshing !== null}
        onClick={() => void store.refresh()}
      >
        <Icon name="refresh" size={18} className={state.refreshing ? "animate-spin" : ""} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="全部标为已读"
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
        title="订阅"
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
            <span className="text-xs">添加订阅</span>
          </Button>
        }
        menuItems={[
          { icon: "refresh", label: "刷新全部", onSelect: () => void store.refresh() },
          { icon: "done_all", label: "全部标为已读", onSelect: () => setConfirmRead(true) },
          { icon: "tune", label: "管理订阅", onSelect: () => setManaging(true) },
        ]}
      />
      {(refreshing || state.failed > 0) && (
        <p role="status" className="px-4 md:px-8 pt-2 text-[11px] text-secondary">
          {refreshing ?? `上次刷新有 ${state.failed} 个订阅失败，在 管理订阅 中查看`}
        </p>
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
              <p className="p-10 text-center text-sm text-secondary">选择一篇文章阅读</p>
            )}
          </section>
        </div>
      ) : (
        <div ref={content} className="px-4 pt-3">
          {pull > 0 && (
            <p className="text-center text-[11px] text-secondary" style={{ height: pull }}>
              {pull >= PULL_TRIGGER ? "松开刷新订阅" : "下拉刷新订阅"}
            </p>
          )}
          {state.feedsLoaded && state.feeds.length === 0 ? (
            <div className="rounded-2xl bg-surface-container-low p-8 text-center space-y-3 mt-4">
              <Icon name="rss_feed" size={28} className="mx-auto text-secondary" />
              <p className="text-sm">还没有订阅</p>
              <div className="flex justify-center gap-2">
                <Button size="sm" onClick={() => setAdding(true)}>
                  添加订阅
                </Button>
                <Button size="sm" variant="outline" onClick={() => setManaging(true)}>
                  导入 OPML
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
          aria-label="文章"
          className="fixed inset-0 z-[45] bg-surface flex flex-col pt-safe"
        >
          <header className="shrink-0 h-12 flex items-center px-2 border-b border-surface-variant/30">
            <Button
              size="icon"
              variant="ghost"
              aria-label="返回"
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
      {confirmRead && (
        <Dialog open onOpenChange={(open) => !open && setConfirmRead(false)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">全部标为已读</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">把「{title}」的文章全部标为已读？</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmRead(false)}>
                取消
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setConfirmRead(false);
                  markAllRead();
                }}
              >
                确定
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

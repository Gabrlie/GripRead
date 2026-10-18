import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useApp } from "../../context/AppContext";
import {
  useLibrary,
  useRuntime,
  useSettings,
  useShelf,
  useShelfPreferences,
} from "../../application/runtime";
import type { LibraryBook } from "../../types/generated";
import {
  READING_GROUPS,
  gainedChapters,
  shelfGroupOf,
  type ShelfChapterLabels,
} from "../../application/shelf";
import { Header } from "../Layout/Header";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { Card, CardContent } from "../ui/card";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { LibraryManager } from "./LibraryManager";
import { BookDetailPage } from "./BookDetailPage";
import { ReadingRecordsPage } from "./ReadingRecordsPage";
import { CloudShelfPage } from "../Cloud/CloudShelfPage";
import { formatDuration, localDay } from "../../application/reading-time";
import { orderBooks } from "../../application/library";
import { GroupManager } from "./GroupManager";
import { LibraryCover } from "./LibraryCover";
import { ComicMark } from "../ui/ComicMark";
import { isComic } from "../../application/comic";
import { DownloadManagerPage } from "./DownloadManagerPage";
import { useLongPress } from "../ui/use-long-press";
import { updateOnlineToc } from "../../application/online";
import { PULL_TRIGGER, usePullRefresh } from "../ui/use-pull-refresh";
import { SLIDE_MS, useSwipePages } from "../ui/use-swipe-pages";
import { t } from "../../i18n";
import { describeError } from "../Cloud/format";

/** 自动更新 runs again on returning to the app after this long. */
const AUTO_UPDATE_GAP = 30 * 60_000;
let lastAutoUpdate = 0;

type ShelfBook = {
  entry: LibraryBook;
  title: string;
  author: string;
  lastReadChapter: string;
  latestChapter: string;
  missing: boolean;
};
export function BookshelfView() {
  const { shelf, setShelf, openReader, setActiveTab, takeDetailReturn } = useApp();
  const { state, store } = useLibrary();
  // 移到回收站 offers 撤销 for a few seconds in the floating toast.
  const lastRemoved = state.lastRemoved;
  useEffect(() => {
    if (!lastRemoved) return;
    toast({
      text: t("shelf.removed", { title: lastRemoved.title }),
      action: {
        label: t("shelf.undo"),
        run: () => void store.restore(lastRemoved.id).catch(() => undefined),
      },
    });
    const timer = window.setTimeout(store.dismissUndo, 6_000);
    return () => window.clearTimeout(timer);
  }, [lastRemoved, store]);
  const { state: groupState, store: groupStore } = useShelf();
  const preferences = useShelfPreferences();
  const [manager, setManager] = useState<"removed" | "sort" | null>(null);
  // Leaving the contents a detail page opened returns to that detail page.
  const [infoBook, setInfoBook] = useState<LibraryBook | null>(takeDetailReturn);
  const [records, setRecords] = useState(false);
  const [cloud, setCloud] = useState(false);
  const runtime = useRuntime();
  const [todaySeconds, setTodaySeconds] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    runtime.services.library.readingStats(localDay()).then(
      (stats) => !cancelled && setTodaySeconds(stats.todaySeconds),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [runtime.services.library, state.books]);
  const [isSearching, setIsSearching] = useState(Boolean(shelf.query));
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const tabsListRef = useRef<HTMLDivElement>(null);
  const groups = [
    ...READING_GROUPS.map((group) => ({ id: group.id as string, label: group.name })),
    ...groupState.groups.map((group) => ({ id: group.id, label: group.name })),
  ];
  const selectedGroup = groups.find((group) => group.id === shelf.groupId);
  const selectedGroupId = selectedGroup?.id ?? "all";
  const layoutMode = shelf.layout;
  const searchQuery = shelf.query;
  const filteredBooks: ShelfBook[] = orderBooks(state.books, shelf.sort)
    .filter(
      (entry) =>
        (selectedGroupId === "all" ||
          shelfGroupOf(
            entry,
            groupState.groups,
            groupState.automatic[entry.book.id] ?? (entry.locator ? "reading" : "unread"),
          ) === selectedGroupId) &&
        `${entry.book.title} ${entry.book.author ?? ""}`
          .toLocaleLowerCase()
          .includes(searchQuery.trim().toLocaleLowerCase()),
    )
    .map((entry) => {
      const labels: ShelfChapterLabels = groupState.chapters[entry.book.id] ?? {
        current: entry.locator ? t("shelf.wholeText") : t("shelf.notRead"),
        latest: t("shelf.wholeText"),
      };
      return {
        entry,
        title: entry.book.title,
        author: entry.book.author ?? t("shelf.unknownAuthor"),
        lastReadChapter:
          entry.asset?.availability === "missing" ? t("shelf.fileMissing") : labels.current,
        latestChapter: labels.latest,
        missing: entry.asset?.availability === "missing",
      };
    });
  const handleAddLocal = () => {
    if (state.importing) {
      store.requestImportDetails();
      return;
    }
    if (state.importOutcome?.phase === "failed") {
      store.requestImportDetails();
      return;
    }
    void store.importFiles();
  };
  const handleUpdateToc = () => void store.refresh();
  // Legado's 更新目录: every online shelf book that allows updates.
  const [updating, setUpdating] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const updatingRef = useRef(false);
  /**
   * `quiet` (自动更新) speaks up only about new chapters; failures show on
   * the books. While the server updates books on its schedule, 自动更新 only
   * syncs to collect what it found instead of asking it to fetch them all.
   */
  const handleUpdateOnline = async (quiet = false) => {
    if (updatingRef.current) return;
    const sync = runtime.services.sync;
    if (quiet && sync?.getServer) {
      const server = await sync.getServer().catch(() => null);
      if (server?.connected && server.updateViaServer) {
        await sync.syncServerNow().catch(() => undefined);
        return;
      }
    }
    if (updatingRef.current) return;
    updatingRef.current = true;
    setUpdating(t("shelf.updating"));
    void updateOnlineToc(runtime.services.sources, [], (event) => {
      if (!event.done)
        setUpdating(t("shelf.updatingCount", { done: event.updated, total: event.total }));
    })
      .then((outcomes) => {
        const added = outcomes.reduce((sum, item) => sum + item.newChapters, 0);
        const failed = outcomes.filter((item) => item.error).length;
        if (!quiet || added > 0)
          toast(
            outcomes.length === 0
              ? t("shelf.nothingToUpdate")
              : `${t("shelf.updated", { added })}${failed ? t("shelf.updatedFailed", { failed }) : ""}`,
          );
        return store.refresh();
      })
      .catch((failure: unknown) => toast({ text: describeError(failure), error: true }))
      .finally(() => {
        updatingRef.current = false;
        setUpdating(null);
      });
  };
  // 自动更新: the first visit to the shelf after the app starts updates its
  // online books' contents, and so does returning to the app a while later.
  const { state: settings } = useSettings();
  const autoUpdate = settings.value ? settings.value.autoUpdateShelf !== false : null;
  const hasOnline = !state.loading && state.books.some((book) => book.online);
  const autoUpdateRef = useRef<() => void>(() => undefined);
  autoUpdateRef.current = () => {
    if (!autoUpdate || !hasOnline) return;
    lastAutoUpdate = Date.now();
    void handleUpdateOnline(true);
  };
  useEffect(() => {
    if (lastAutoUpdate === 0) autoUpdateRef.current();
  }, [autoUpdate, hasOnline]);
  useEffect(() => {
    const returned = () => {
      if (document.visibilityState === "visible" && Date.now() - lastAutoUpdate >= AUTO_UPDATE_GAP)
        autoUpdateRef.current();
    };
    document.addEventListener("visibilitychange", returned);
    return () => document.removeEventListener("visibilitychange", returned);
  }, []);
  const content = useRef<HTMLDivElement>(null);
  const pull = usePullRefresh(content, () => void handleUpdateOnline());
  // Swiping sideways moves between groups in the tab order.
  const groupIndex = Math.max(
    0,
    groups.findIndex((group) => group.id === selectedGroupId),
  );
  const swipe = useSwipePages(
    content,
    (step) => {
      const next = groups[groupIndex + step];
      if (next) setShelf({ groupId: next.id });
    },
    (step) => Boolean(groups[groupIndex + step]),
  );
  useEffect(() => {
    const tab = tabsListRef.current?.querySelector<HTMLElement>("[data-active]");
    tab?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [selectedGroupId]);
  const handleToggleLayout = () => setShelf({ layout: layoutMode === "list" ? "grid" : "list" });
  useEffect(() => {
    if (!state.loading && !state.error) void groupStore.load(state.books);
  }, [state.books, state.loading, state.error, groupStore]);
  useEffect(() => {
    window.scrollTo(0, shelf.scroll);
  }, []);

  useEffect(() => {
    if (
      preferences.state.value &&
      !groupState.loading &&
      !groupState.error &&
      !selectedGroup &&
      shelf.groupId !== "all"
    )
      setShelf({ groupId: "all" });
  }, [
    groupState.loading,
    groupState.error,
    selectedGroup,
    shelf.groupId,
    setShelf,
    preferences.state.value,
  ]);

  // 书架页专属：挂载时隐藏全局/窗口滚动条，卸载时恢复
  useEffect(() => {
    document.documentElement.classList.add("shelf-hide-scrollbar");
    document.body.classList.add("shelf-hide-scrollbar");
    return () => {
      document.documentElement.classList.remove("shelf-hide-scrollbar");
      document.body.classList.remove("shelf-hide-scrollbar");
    };
  }, []);

  // Horizontal drag-to-scroll and non-passive wheel isolation for category tabs
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragScrollLeftRef = useRef(0);
  const hasDraggedRef = useRef(false);

  // Native non-passive wheel and touch listener: isolate horizontal tab scrolling from vertical page scroll
  useEffect(() => {
    const el = tabsListRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // If tabs list has horizontal overflow
      if (el.scrollWidth <= el.clientWidth) return;

      // Stop wheel event from propagating to window/document
      e.stopPropagation();

      // If vertical mouse wheel scroll
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault(); // Stop window from scrolling vertically!
        el.scrollLeft += e.deltaY;
      } else if (Math.abs(e.deltaX) > 0) {
        // Trackpad horizontal swipe: prevent any vertical drift from scrolling the window
        if (Math.abs(e.deltaY) > 0) {
          e.preventDefault();
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      // Prevent touchmove from bubbling to window scroll handlers while touching tabs
      e.stopPropagation();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: true });

    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (!tabsListRef.current) return;
    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    dragStartXRef.current = e.clientX;
    dragScrollLeftRef.current = tabsListRef.current.scrollLeft;
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || !tabsListRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const deltaX = e.clientX - dragStartXRef.current;
    if (Math.abs(deltaX) > 4) {
      hasDraggedRef.current = true;
      if (!e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.setPointerCapture(e.pointerId);
    }
    tabsListRef.current.scrollLeft = dragScrollLeftRef.current - deltaX;
  };

  const handlePointerUpOrLeave = (e: PointerEvent<HTMLDivElement>) => {
    isDraggingRef.current = false;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex-1 flex flex-col relative w-full bg-surface shelf-hide-scrollbar overflow-x-clip">
      {/*
        统一连续毛玻璃顶栏 (Unified Continuous Glass Header)
        顶栏与分类横滑栏统一置于原生类苹果毛玻璃容器中，精准匹配 macOS 原生窗口标题栏透光率与色调
      */}
      <div
        data-no-swipe
        className="fixed top-0 left-0 right-0 z-30 md:left-64 glass-header pt-safe"
      >
        {/* Row 1: Header (h-14) */}
        <Header
          title={t("shelf.title")}
          subtitle="BOOKSHELF"
          readingTime={todaySeconds === null ? undefined : formatDuration(todaySeconds)}
          standalone={false}
          onSearchClick={() => setIsSearching((prev) => !prev)}
          menuItems={[
            { icon: "add", label: t("shelf.menu.add"), onSelect: handleAddLocal },
            {
              icon: "folder_open",
              label: t("shelf.menu.folder"),
              onSelect: () =>
                state.importing ? store.requestImportDetails() : void store.importFolder(),
            },
            { icon: "sync", label: t("shelf.menu.refresh"), onSelect: handleUpdateToc },
            ...(state.books.some((entry) => entry.online)
              ? [
                  {
                    icon: "refresh",
                    label: t("shelf.menu.update"),
                    detail: updating ?? undefined,
                    onSelect: () => void handleUpdateOnline(),
                  },
                  {
                    icon: "download",
                    label: t("shelf.menu.downloads"),
                    onSelect: () => setOffline(true),
                  },
                ]
              : []),
            {
              icon: layoutMode === "grid" ? "view_list" : "grid_view",
              label: t("shelf.menu.layout"),
              detail: layoutMode === "grid" ? t("shelf.layout.grid") : t("shelf.layout.list"),
              onSelect: handleToggleLayout,
            },
            { icon: "swap_vert", label: t("shelf.menu.sort"), onSelect: () => setManager("sort") },
            {
              icon: "label",
              label: t("shelf.menu.groups"),
              onSelect: () => setIsGroupModalOpen(true),
            },
            { icon: "schedule", label: t("shelf.menu.records"), onSelect: () => setRecords(true) },
            { icon: "cloud", label: t("shelf.menu.cloud"), onSelect: () => setCloud(true) },
            { icon: "delete", label: t("shelf.menu.bin"), onSelect: () => setManager("removed") },
          ]}
        />

        {/* Row 2: Category Tabs Bar (流畅左右滑动，支持鼠标滚轮/触摸横向滚动，极简下划线滑块) */}
        <div className="py-1.5 px-margin-mobile md:px-8 w-full min-w-0">
          <div className="max-w-5xl mx-auto w-full min-w-0 overflow-hidden">
            <Tabs
              value={selectedGroupId}
              onValueChange={(id) => {
                if (hasDraggedRef.current) return;
                const index = groups.findIndex((group) => group.id === id);
                if (index === groupIndex) return;
                swipe.slide(index > groupIndex ? 1 : -1, () => setShelf({ groupId: String(id) }));
              }}
              className="w-full min-w-0"
            >
              <TabsList
                ref={tabsListRef}
                variant="line"
                aria-label={t("shelf.groups")}
                data-testid="shelf-groups"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUpOrLeave}
                onPointerLeave={handlePointerUpOrLeave}
                style={{
                  touchAction: "pan-x",
                  overscrollBehaviorX: "contain",
                  overscrollBehaviorY: "none",
                }}
                className="bg-transparent p-0 h-auto overflow-x-auto no-scrollbar max-w-full flex items-center !justify-start justify-start gap-5 sm:gap-6 border-0 shadow-none select-none cursor-grab active:cursor-grabbing w-full min-w-0 flex-nowrap"
              >
                {groups.map((cat) => {
                  const isSelected = selectedGroupId === cat.id;
                  return (
                    <TabsTrigger
                      key={cat.id}
                      value={cat.id}
                      onClick={(e) => {
                        if (hasDraggedRef.current) {
                          e.preventDefault();
                          e.stopPropagation();
                        }
                      }}
                      className={`relative !flex-none flex-none shrink-0 py-1.5 px-0.5 font-label-md text-xs sm:text-sm transition-colors whitespace-nowrap !bg-transparent data-[active]:!bg-transparent shadow-none border-0 rounded-none cursor-pointer focus-visible:outline-none ${
                        isSelected
                          ? "!text-primary font-semibold"
                          : "text-secondary hover:text-on-surface"
                      }`}
                    >
                      <span>{cat.label}</span>
                      {isSelected && (
                        <div className="absolute -bottom-1 left-0 right-0 h-[2px] bg-primary rounded-full transition-all duration-300" />
                      )}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          </div>
        </div>
      </div>

      {/* 下拉刷新, and the progress of an update however it started. */}
      <div
        role="status"
        aria-hidden={!pull.distance && !updating}
        className="fixed left-0 right-0 md:left-64 z-20 flex justify-center pointer-events-none top-[calc(112px+var(--safe-top))]"
        style={{
          opacity: updating ? 1 : Math.min(1, pull.distance / PULL_TRIGGER),
          transform: `translateY(${updating ? 6 : Math.max(0, pull.distance / 2 - 14)}px)`,
          transition: pull.dragging ? "none" : "opacity 200ms ease-out, transform 300ms ease-out",
        }}
      >
        <span className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1.5 text-xs text-secondary shadow-sm">
          <Icon
            name="refresh"
            size={14}
            className={updating ? "animate-spin" : ""}
            style={updating ? undefined : { transform: `rotate(${pull.distance * 4}deg)` }}
          />
          {updating ??
            (pull.distance >= PULL_TRIGGER ? t("shelf.pull.release") : t("shelf.pull.hint"))}
        </span>
      </div>

      {/* Main Content Area: 留出状态栏、连续顶栏与分组栏总高度空间 */}
      <div
        ref={content}
        // The whole screen below the header swipes, however short the list.
        className="flex flex-col w-full min-h-[100dvh] max-w-5xl mx-auto px-3 sm:px-4 md:px-8 pt-[calc(112px+var(--safe-top))] pb-[calc(6rem+var(--safe-bottom))] md:pb-8"
        style={{
          touchAction: "pan-y",
          transform:
            pull.distance || swipe.offset
              ? `translate3d(${swipe.offset}px, ${pull.distance}px, 0)`
              : undefined,
          transition:
            pull.dragging || (!swipe.animate && swipe.offset !== 0)
              ? "none"
              : `transform ${SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
        }}
      >
        {/* Search Bar (Expandable) */}
        {isSearching && (
          <div className="mb-4 animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex items-center bg-surface-container h-10 px-3 rounded-xl shadow-xs border border-surface-variant/30">
              <Icon name="search" size={18} className="text-secondary mr-2 shrink-0" />
              <Input
                autoFocus
                value={searchQuery}
                aria-label={t("shelf.search")}
                onChange={(e) => setShelf({ query: e.target.value })}
                placeholder={t("shelf.search.placeholder")}
                className="w-full bg-transparent border-0 shadow-none focus-visible:ring-0 p-0 text-xs text-on-surface placeholder:text-outline"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label={t("shelf.search.clear")}
                  onClick={() => setShelf({ query: "" })}
                  className="text-secondary hover:text-on-surface p-1"
                >
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
          </div>
        )}

        {(state.error || groupState.error || Object.keys(groupState.chapterErrors).length > 0) && (
          <div role="alert" className="text-xs text-error rounded-xl bg-error-container p-3 mb-3">
            {state.error || groupState.error || t("shelf.tocFailed")}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                state.error ? void store.refresh() : void groupStore.load(state.books)
              }
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        {state.loading && (
          <p role="status" className="text-xs text-secondary">
            {t("shelf.loading")}
          </p>
        )}
        {preferences.state.error && (
          <div role="alert" className="text-xs text-error rounded-xl bg-error-container p-3 mb-3">
            {t("shelf.prefsFailed", { error: preferences.state.error })}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                preferences.state.value ? preferences.store.retry() : void preferences.store.load()
              }
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        {state.managementError && !manager && (
          <p role="alert" className="text-xs text-error">
            {state.managementError}
          </p>
        )}
        {/* Book List / Grid */}
        <section aria-label={t("shelf.list")} className="mt-1 pb-6">
          {state.loading ? (
            <p role="status" className="text-xs text-secondary py-10 text-center">
              {t("shelf.loading")}
            </p>
          ) : state.error ? null : filteredBooks.length === 0 ? (
            <div className="bg-surface-container-low rounded-2xl p-10 text-center my-6 space-y-3 border border-surface-variant/30">
              <div className="w-12 h-12 rounded-full bg-surface-container mx-auto flex items-center justify-center text-secondary">
                <Icon name="auto_stories" size={24} />
              </div>
              <p className="font-title-editorial text-on-surface text-sm">
                {state.books.length ? t("shelf.noMatch") : t("shelf.empty")}
              </p>
              <Button
                data-testid="import-button"
                variant="default"
                size="sm"
                onClick={handleAddLocal}
                className="mt-2 bg-primary text-on-primary text-xs cursor-pointer"
              >
                {t("shelf.import")}
              </Button>
            </div>
          ) : layoutMode === "list" ? (
            <div className="flex flex-col gap-3">
              {filteredBooks.map((book) => (
                <BookCardList
                  key={book.entry.book.id}
                  book={book}
                  onOpen={() => openReader(book.entry)}
                  onInfo={() => setInfoBook(book.entry)}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3.5">
              {filteredBooks.map((book) => (
                <BookCardGrid
                  key={book.entry.book.id}
                  book={book}
                  onOpen={() => openReader(book.entry)}
                  onInfo={() => setInfoBook(book.entry)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <LibraryManager mode={manager} onClose={() => setManager(null)} />
      {offline && <DownloadManagerPage onClose={() => setOffline(false)} />}
      {infoBook && (
        <BookDetailPage
          book={state.books.find((entry) => entry.book.id === infoBook.book.id) ?? infoBook}
          onOpen={(page) => {
            setInfoBook(null);
            openReader(infoBook, page);
          }}
          onClose={() => setInfoBook(null)}
        />
      )}
      {records && (
        <ReadingRecordsPage
          onClose={() => setRecords(false)}
          onOpenBook={(book) => {
            setRecords(false);
            setInfoBook(book);
          }}
        />
      )}
      {cloud && (
        <CloudShelfPage
          onClose={() => setCloud(false)}
          onSetUp={() => {
            setCloud(false);
            setActiveTab("settings");
          }}
        />
      )}
      <GroupManager open={isGroupModalOpen} onOpenChange={setIsGroupModalOpen} />
    </div>
  );
}
// 1. List View Card (Requirement 3: 封面固定比例4:3，无放大动画，无左上序号；右侧严格4行均等间距：书名、作者名、读至目录章节、最新目录与更新时间)
function BookCardList({
  book,
  onOpen,
  onInfo,
}: {
  book: ShelfBook;
  onOpen: () => void;
  onInfo: () => void;
}) {
  const press = useLongPress(onInfo, onOpen);
  return (
    <Card
      data-testid={`library-book-${book.entry.book.id}`}
      role="button"
      tabIndex={0}
      {...press}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="book-card bg-surface-container-low hover:bg-surface-container border-surface-variant/30 transition-colors duration-200 rounded-xl p-3 sm:p-3.5 shadow-xs cursor-pointer"
    >
      <CardContent className="p-0 flex gap-3.5 items-center">
        {/* Book Cover: Fixed 4:3 (portrait) aspect ratio, no hover scale, no corner badge */}
        <div className="relative w-20 aspect-[3/4] shrink-0 rounded-lg overflow-hidden bg-surface-container-high shadow-xs">
          <LibraryCover book={book.entry} title={book.title} />
          {book.entry.inCloud && <CloudMark />}
          <NewChaptersMark book={book.entry} />
          <PausedMark book={book.entry} />
        </div>

        {/* Right Content: Strictly 4 lines with identical, uniform spacing */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-2 py-0.5 self-center">
          {/* Line 1: 书名（不手动添加书名号） */}
          <h2 className="flex items-center gap-1.5 font-headline-sm text-sm sm:text-base text-on-surface font-medium tracking-tight leading-snug min-w-0">
            <span className="truncate">{book.title}</span>
            {isComic(book.entry) && <ComicMark />}
          </h2>

          {/* Line 2: 作者名 */}
          <p className="font-body-sm text-xs text-secondary truncate leading-normal">
            {book.author}
          </p>

          {/* Line 3: 读至目录以及章节名 */}
          <p className="font-body-sm text-xs text-on-surface-variant truncate leading-normal">
            {t("shelf.readTo", { chapter: book.lastReadChapter || t("shelf.firstChapter") })}
          </p>

          {/* Line 4: 最新目录 以及 右侧的更新时间（本地书籍不显示更新时间） */}
          <div className="flex items-center justify-between gap-2 text-xs text-secondary min-w-0 leading-normal">
            <span className="truncate min-w-0 text-[11px] sm:text-xs">
              {t("shelf.latest", {
                chapter: book.latestChapter || book.lastReadChapter || t("shelf.firstChapter"),
              })}
            </span>
            {Boolean(book.entry.online?.newChapters) && (
              <span className="shrink-0 rounded px-1 text-[10px] leading-4 bg-primary/10 text-primary">
                {t("shelf.new", { count: book.entry.online!.newChapters })}
              </span>
            )}
            {book.entry.online?.updateError && (
              <span
                className="shrink-0 text-[10px] text-error"
                title={book.entry.online.updateError}
              >
                {t("shelf.updateFailed")}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// 2. Grid View Card
function BookCardGrid({
  book,
  onOpen,
  onInfo,
}: {
  book: ShelfBook;
  onOpen: () => void;
  onInfo: () => void;
}) {
  const press = useLongPress(onInfo, onOpen);
  return (
    <div
      data-testid={`library-book-${book.entry.book.id}`}
      role="button"
      tabIndex={0}
      {...press}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="flex flex-col cursor-pointer transition-colors text-left"
    >
      <div className="relative aspect-[3/4] rounded-xl overflow-hidden bg-surface-container-high shadow-xs mb-1.5">
        <LibraryCover book={book.entry} title={book.title} />
        {book.entry.inCloud && <CloudMark />}
        {isComic(book.entry) && <ComicMark onCover />}
        <NewChaptersMark book={book.entry} />
        <PausedMark book={book.entry} />
      </div>
      <h3 className="font-title-editorial text-xs font-semibold text-on-surface truncate">
        {book.title}
      </h3>
      <p className="text-[11px] text-secondary truncate mt-0.5">{book.author}</p>
    </div>
  );
}

/**
 * Legado's count of chapters still unread: red when the book gained
 * chapters since it was last read, grey otherwise.
 */
function NewChaptersMark({ book }: { book: LibraryBook }) {
  const { state } = useShelf();
  const labels = state.chapters[book.book.id];
  const count = labels?.remaining ?? 0;
  if (!count) return null;
  const fresh = gainedChapters(book, labels);
  return (
    <span
      aria-label={t("shelf.unread", { count })}
      data-fresh={fresh ? "true" : undefined}
      className={`absolute right-1 top-1 min-w-4 h-4 px-1 rounded-full text-[10px] leading-4 text-center tabular-nums shadow-xs ${
        fresh ? "bg-error text-on-error" : "bg-surface-container-highest/90 text-on-surface-variant"
      }`}
    >
      {count}
    </span>
  );
}

/** A quiet corner mark on an online book whose 允许更新 is off. */
function PausedMark({ book }: { book: LibraryBook }) {
  if (!book.online || book.online.canUpdate) return null;
  return (
    <span
      role="img"
      aria-label={t("shelf.paused")}
      title={t("shelf.paused")}
      className="absolute left-1 bottom-1 h-4 w-4 rounded-full bg-surface/80 text-secondary flex items-center justify-center shadow-xs"
    >
      <Icon name="pause" size={10} />
    </span>
  );
}

/** A quiet corner mark on the cover of a book that is on the cloud bookshelf. */
function CloudMark() {
  return (
    <span
      role="img"
      aria-label={t("shelf.inCloud")}
      title={t("shelf.inCloud")}
      className="absolute right-1 bottom-1 h-4 w-4 rounded-full bg-surface/80 text-secondary flex items-center justify-center shadow-xs"
    >
      <Icon name="cloud" size={10} />
    </span>
  );
}

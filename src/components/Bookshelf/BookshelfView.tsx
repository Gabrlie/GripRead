import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useApp } from "../../context/AppContext";
import { useLibrary, useRuntime, useShelf, useShelfPreferences } from "../../application/runtime";
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
import { DownloadManagerPage } from "./DownloadManagerPage";
import { useLongPress } from "../ui/use-long-press";
import { updateOnlineToc } from "../../application/online";

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
      text: `已移到回收站：${lastRemoved.title}`,
      action: {
        label: "撤销",
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
        current: entry.locator ? "全文" : "尚未阅读",
        latest: "全文",
      };
      return {
        entry,
        title: entry.book.title,
        author: entry.book.author ?? "作者未知",
        lastReadChapter: entry.asset?.availability === "missing" ? "文件缺失" : labels.current,
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
  const handleUpdateOnline = () => {
    if (updating) return;
    setUpdating("正在更新目录…");
    void updateOnlineToc(runtime.services.sources, [], (event) => {
      if (!event.done) setUpdating(`正在更新目录 ${event.updated}/${event.total}`);
    })
      .then((outcomes) => {
        const added = outcomes.reduce((sum, item) => sum + item.newChapters, 0);
        const failed = outcomes.filter((item) => item.error).length;
        toast(
          outcomes.length === 0
            ? "书架上没有可以更新的网络书籍"
            : `目录已更新：${added} 个新章节${failed ? `，${failed} 本失败` : ""}`,
        );
        return store.refresh();
      })
      .catch((failure: unknown) => toast({ text: String(failure), error: true }))
      .finally(() => setUpdating(null));
  };
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
    <div className="flex-1 flex flex-col relative w-full bg-surface shelf-hide-scrollbar">
      {/*
        统一连续毛玻璃顶栏 (Unified Continuous Glass Header)
        顶栏与分类横滑栏统一置于原生类苹果毛玻璃容器中，精准匹配 macOS 原生窗口标题栏透光率与色调
      */}
      <div className="fixed top-0 left-0 right-0 z-30 md:left-64 glass-header pt-safe">
        {/* Row 1: Header (h-14) */}
        <Header
          title="书架"
          subtitle="BOOKSHELF"
          readingTime={todaySeconds === null ? undefined : formatDuration(todaySeconds)}
          standalone={false}
          onSearchClick={() => setIsSearching((prev) => !prev)}
          menuItems={[
            { icon: "add", label: "添加本地", onSelect: handleAddLocal },
            {
              icon: "folder_open",
              label: "导入文件夹",
              onSelect: () =>
                state.importing ? store.requestImportDetails() : void store.importFolder(),
            },
            { icon: "sync", label: "刷新书架", onSelect: handleUpdateToc },
            ...(state.books.some((entry) => entry.online)
              ? [
                  {
                    icon: "refresh",
                    label: "更新目录",
                    detail: updating ?? undefined,
                    onSelect: handleUpdateOnline,
                  },
                  { icon: "download", label: "下载管理", onSelect: () => setOffline(true) },
                ]
              : []),
            {
              icon: layoutMode === "grid" ? "view_list" : "grid_view",
              label: "书架布局",
              detail: layoutMode === "grid" ? "网格" : "列表",
              onSelect: handleToggleLayout,
            },
            { icon: "swap_vert", label: "书架排序", onSelect: () => setManager("sort") },
            { icon: "label", label: "分组管理", onSelect: () => setIsGroupModalOpen(true) },
            { icon: "schedule", label: "阅读记录", onSelect: () => setRecords(true) },
            { icon: "cloud", label: "云书架", onSelect: () => setCloud(true) },
            { icon: "delete", label: "回收站", onSelect: () => setManager("removed") },
          ]}
        />

        {/* Row 2: Category Tabs Bar (流畅左右滑动，支持鼠标滚轮/触摸横向滚动，极简下划线滑块) */}
        <div className="py-1.5 px-margin-mobile md:px-8 w-full min-w-0">
          <div className="max-w-5xl mx-auto w-full min-w-0 overflow-hidden">
            <Tabs
              value={selectedGroupId}
              onValueChange={(id) => {
                if (!hasDraggedRef.current) setShelf({ groupId: String(id) });
              }}
              className="w-full min-w-0"
            >
              <TabsList
                ref={tabsListRef}
                variant="line"
                aria-label="书架分组"
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

      {/* Main Content Area: 留出状态栏、连续顶栏与分组栏总高度空间 */}
      <div className="flex flex-col w-full max-w-5xl mx-auto px-3 sm:px-4 md:px-8 pt-[calc(112px+var(--safe-top))] pb-[calc(6rem+var(--safe-bottom))] md:pb-8">
        {/* Search Bar (Expandable) */}
        {isSearching && (
          <div className="mb-4 animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex items-center bg-surface-container h-10 px-3 rounded-xl shadow-xs border border-surface-variant/30">
              <Icon name="search" size={18} className="text-secondary mr-2 shrink-0" />
              <Input
                autoFocus
                value={searchQuery}
                aria-label="搜索本地书籍"
                onChange={(e) => setShelf({ query: e.target.value })}
                placeholder="搜索书名或作家..."
                className="w-full bg-transparent border-0 shadow-none focus-visible:ring-0 p-0 text-xs text-on-surface placeholder:text-outline"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="清除搜索"
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
            {state.error || groupState.error || "部分书籍的目录读取失败，已保留可用的书架信息。"}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                state.error ? void store.refresh() : void groupStore.load(state.books)
              }
            >
              重试
            </Button>
          </div>
        )}
        {state.loading && (
          <p role="status" className="text-xs text-secondary">
            正在读取书架…
          </p>
        )}
        {preferences.state.error && (
          <div role="alert" className="text-xs text-error rounded-xl bg-error-container p-3 mb-3">
            书架偏好保存失败：{preferences.state.error}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                preferences.state.value ? preferences.store.retry() : void preferences.store.load()
              }
            >
              重试
            </Button>
          </div>
        )}
        {state.managementError && !manager && (
          <p role="alert" className="text-xs text-error">
            {state.managementError}
          </p>
        )}
        {/* Book List / Grid */}
        <section aria-label="书架书籍列表" className="mt-1 pb-6">
          {state.loading ? (
            <p role="status" className="text-xs text-secondary py-10 text-center">
              正在读取书架…
            </p>
          ) : state.error ? null : filteredBooks.length === 0 ? (
            <div className="bg-surface-container-low rounded-2xl p-10 text-center my-6 space-y-3 border border-surface-variant/30">
              <div className="w-12 h-12 rounded-full bg-surface-container mx-auto flex items-center justify-center text-secondary">
                <Icon name="auto_stories" size={24} />
              </div>
              <p className="font-title-editorial text-on-surface text-sm">
                {state.books.length ? "书架暂无符合条件的书籍" : "从一本本地小说开始"}
              </p>
              <Button
                data-testid="import-button"
                variant="default"
                size="sm"
                onClick={handleAddLocal}
                className="mt-2 bg-primary text-on-primary text-xs cursor-pointer"
              >
                导入本地小说
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
        </div>

        {/* Right Content: Strictly 4 lines with identical, uniform spacing */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-2 py-0.5 self-center">
          {/* Line 1: 书名（不手动添加书名号） */}
          <h2 className="font-headline-sm text-sm sm:text-base text-on-surface font-medium truncate tracking-tight leading-snug">
            {book.title}
          </h2>

          {/* Line 2: 作者名 */}
          <p className="font-body-sm text-xs text-secondary truncate leading-normal">
            {book.author}
          </p>

          {/* Line 3: 读至目录以及章节名 */}
          <p className="font-body-sm text-xs text-on-surface-variant truncate leading-normal">
            读至：{book.lastReadChapter || "第一章"}
          </p>

          {/* Line 4: 最新目录 以及 右侧的更新时间（本地书籍不显示更新时间） */}
          <div className="flex items-center justify-between gap-2 text-xs text-secondary min-w-0 leading-normal">
            <span className="truncate min-w-0 text-[11px] sm:text-xs">
              最新：{book.latestChapter || book.lastReadChapter || "第一章"}
            </span>
            {Boolean(book.entry.online?.newChapters) && (
              <span className="shrink-0 rounded px-1 text-[10px] leading-4 bg-primary/10 text-primary">
                新 {book.entry.online!.newChapters}
              </span>
            )}
            {book.entry.online?.updateError && (
              <span
                className="shrink-0 text-[10px] text-error"
                title={book.entry.online.updateError}
              >
                更新失败
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
        <NewChaptersMark book={book.entry} />
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
      aria-label={`还有 ${count} 章未读`}
      data-fresh={fresh ? "true" : undefined}
      className={`absolute right-1 top-1 min-w-4 h-4 px-1 rounded-full text-[10px] leading-4 text-center tabular-nums shadow-xs ${
        fresh ? "bg-error text-on-error" : "bg-surface-container-highest/90 text-on-surface-variant"
      }`}
    >
      {count}
    </span>
  );
}

/** A quiet corner mark on the cover of a book that is on the cloud bookshelf. */
function CloudMark() {
  return (
    <span
      role="img"
      aria-label="已上传到云书架"
      title="已上传到云书架"
      className="absolute right-1 bottom-1 h-4 w-4 rounded-full bg-surface/80 text-secondary flex items-center justify-center shadow-xs"
    >
      <Icon name="cloud" size={10} />
    </span>
  );
}

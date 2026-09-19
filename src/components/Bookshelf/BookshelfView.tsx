import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useApp } from "../../context/AppContext";
import { useLibrary, useShelf } from "../../application/runtime";
import type { LibraryBook } from "../../types/generated";
import type { ShelfChapterLabels } from "../../application/shelf";
import { Header } from "../Layout/Header";
import { Icon } from "../ui/Icon";
import { Card, CardContent } from "../ui/card";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { GroupManager } from "./GroupManager";

type ShelfBook = {
  entry: LibraryBook;
  title: string;
  author: string;
  coverUrl?: string;
  lastReadChapter: string;
  latestChapter: string;
  missing: boolean;
};
export function BookshelfView() {
  const { shelf, setShelf, openReader } = useApp();
  const { state, store } = useLibrary();
  const { state: groupState, store: groupStore } = useShelf();
  const [isSearching, setIsSearching] = useState(Boolean(shelf.query));
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const tabsListRef = useRef<HTMLDivElement>(null);
  const groups = [
    { id: "all", label: "全部" },
    ...groupState.groups.map((group) => ({ id: group.id, label: group.name })),
  ];
  const selectedGroup = groupState.groups.find((group) => group.id === shelf.groupId);
  const selectedGroupId = selectedGroup?.id ?? shelf.groupId ?? "all";
  const selectedBooks = selectedGroup ? new Set(selectedGroup.bookIds) : null;
  const layoutMode = shelf.layout;
  const searchQuery = shelf.query;
  const filteredBooks: ShelfBook[] = state.books
    .filter(
      (entry) =>
        (!selectedBooks || selectedBooks.has(entry.book.id)) &&
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
        lastReadChapter: entry.asset.availability === "missing" ? "文件缺失" : labels.current,
        latestChapter: labels.latest,
        missing: entry.asset.availability === "missing",
      };
    });
  const handleAddLocal = () => void store.importTxt();
  const handleUpdateToc = () => void store.refresh();
  const handleToggleLayout = () => setShelf({ layout: layoutMode === "list" ? "grid" : "list" });
  useEffect(() => {
    if (!state.loading && !state.error) void groupStore.load(state.books);
  }, [state.books, state.loading, state.error, groupStore]);
  useEffect(() => {
    window.scrollTo(0, shelf.scroll);
  }, []);

  useEffect(() => {
    if (!groupState.loading && !groupState.error && !selectedGroup && shelf.groupId !== "all")
      setShelf({ groupId: "all" });
  }, [groupState.loading, groupState.error, selectedGroup, shelf.groupId, setShelf]);

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
      <div className="fixed top-0 left-0 right-0 z-30 md:left-64 glass-header">
        {/* Row 1: Header (h-14) */}
        <Header
          title="书架"
          subtitle="BOOKSHELF"
          readingTime="— 分钟"
          standalone={false}
          onSearchClick={() => setIsSearching((prev) => !prev)}
          onUpdateToc={handleUpdateToc}
          onAddLocal={handleAddLocal}
          onToggleLayout={handleToggleLayout}
          layoutMode={layoutMode}
          onGroupManage={() => setIsGroupModalOpen(true)}
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

      {/* Main Content Area: pt-[112px] 留出连续顶栏与分组栏总高度空间 */}
      <div className="flex flex-col w-full max-w-5xl mx-auto px-3 sm:px-4 md:px-8 pt-[112px] pb-24 md:pb-8">
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
        {/* Book List / Grid */}
        <section aria-label="书架书籍列表" className="mt-1 pb-6">
          {filteredBooks.length === 0 ? (
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
                disabled={state.importing}
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
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <GroupManager open={isGroupModalOpen} onOpenChange={setIsGroupModalOpen} />
    </div>
  );
}
// 1. List View Card (Requirement 3: 封面固定比例4:3，无放大动画，无左上序号；右侧严格4行均等间距：书名、作者名、读至目录章节、最新目录与更新时间)
function BookCardList({ book, onOpen }: { book: ShelfBook; onOpen: () => void }) {
  return (
    <Card
      data-testid={`library-book-${book.entry.book.id}`}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onClick={onOpen}
      className="book-card bg-surface-container-low hover:bg-surface-container border-surface-variant/30 transition-colors duration-200 rounded-xl p-3 sm:p-3.5 shadow-xs cursor-pointer"
    >
      <CardContent className="p-0 flex gap-3.5 items-center">
        {/* Book Cover: Fixed 4:3 (portrait) aspect ratio, no hover scale, no corner badge */}
        <div className="relative w-20 aspect-[3/4] shrink-0 rounded-lg overflow-hidden bg-surface-container-high shadow-xs">
          <BookCover title={book.title} coverUrl={book.coverUrl} />
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
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// 2. Grid View Card
function BookCardGrid({ book, onOpen }: { book: ShelfBook; onOpen: () => void }) {
  return (
    <div
      data-testid={`library-book-${book.entry.book.id}`}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onClick={onOpen}
      className="flex flex-col cursor-pointer transition-colors text-left"
    >
      <div className="relative aspect-[3/4] rounded-xl overflow-hidden bg-surface-container-high shadow-xs mb-1.5">
        <BookCover title={book.title} coverUrl={book.coverUrl} />
      </div>
      <h3 className="font-title-editorial text-xs font-semibold text-on-surface truncate">
        {book.title}
      </h3>
      <p className="text-[11px] text-secondary truncate mt-0.5">{book.author}</p>
    </div>
  );
}

const LOCAL_COVER_PALETTES = [
  {
    bg: "bg-gradient-to-br from-[#8b3a2b] via-[#6d2517] to-[#451209]",
    badge: "text-[#fcd8d0]",
    text: "text-[#ffede9]",
  }, // 朱砂熟赭
  {
    bg: "bg-gradient-to-br from-[#1e4d3a] via-[#143829] to-[#0a2016]",
    badge: "text-[#c8eedc]",
    text: "text-[#e8f8f0]",
  }, // 竹青碧玉
  {
    bg: "bg-gradient-to-br from-[#244263] via-[#182f48] to-[#0c1a29]",
    badge: "text-[#cfe2f8]",
    text: "text-[#eef5fc]",
  }, // 砚墨霁蓝
  {
    bg: "bg-gradient-to-br from-[#855323] via-[#633a12] to-[#3a1f06]",
    badge: "text-[#fde4c8]",
    text: "text-[#fef4ea]",
  }, // 暖茶琥珀
  {
    bg: "bg-gradient-to-br from-[#53315e] via-[#3d2047] to-[#25102d]",
    badge: "text-[#ebd4f5]",
    text: "text-[#f8f0fc]",
  }, // 绛紫云锦
  {
    bg: "bg-gradient-to-br from-[#3b474e] via-[#2a343a] to-[#161c20]",
    badge: "text-[#d7e3ea]",
    text: "text-[#f0f5f8]",
  }, // 金石苍青
];

function getCoverTheme(title: string) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) & 0xffffffff;
  }
  return LOCAL_COVER_PALETTES[Math.abs(hash) % LOCAL_COVER_PALETTES.length];
}

function BookCover({ title, coverUrl }: { title: string; coverUrl?: string }) {
  const [hasError, setHasError] = useState(false);
  if (coverUrl && !hasError) {
    return (
      <img
        src={coverUrl}
        alt={title}
        className="w-full h-full object-cover"
        loading="lazy"
        onError={() => setHasError(true)}
      />
    );
  }
  const theme = getCoverTheme(title);
  const cleanTitle = title.replace(/^《|》$/g, "").trim();
  return (
    <div
      aria-hidden="true"
      className={`w-full h-full flex flex-col justify-between p-2 sm:p-2.5 ${theme.bg} shadow-inner select-none relative overflow-hidden border-l-2 border-white/20`}
    >
      <div className="flex items-center justify-between w-full opacity-85">
        <Icon name="auto_stories" size={14} className={theme.badge} />
        <span className={`text-[9px] font-mono font-semibold tracking-wider ${theme.badge}`}>
          TXT
        </span>
      </div>
      <div className="flex flex-col gap-0.5 mt-auto">
        <span
          className={`text-[10px] sm:text-[11px] font-title-editorial font-semibold line-clamp-3 leading-snug tracking-tight ${theme.text}`}
        >
          {cleanTitle}
        </span>
      </div>
    </div>
  );
}

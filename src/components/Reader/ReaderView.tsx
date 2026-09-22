import {
  useState,
  useEffect,
  useRef,
  useLayoutEffect,
  useCallback,
  useSyncExternalStore,
} from "react";
import { useReducedMotion } from "motion/react";
import { useApp } from "../../context/AppContext";
import { useLibrary, useRuntime, useSettings } from "../../application/runtime";
import { ReaderController, DomReaderMeasurer, StPageFlipAdapter } from "../../reader";
import type { ReaderSnapshot } from "../../reader";
import type {
  Bookmark,
  SearchMatch,
  TocEntry,
  TxtEncoding,
  TxtEncodingInfo,
} from "../../types/generated";
import { Button } from "../ui/button";
import { Slider } from "../ui/slider";
import { Icon } from "../ui/Icon";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";

const empty: ReaderSnapshot = {
  bookId: null,
  page: null,
  contentWindow: null,
  pageIndex: 0,
  pageCount: 0,
  hasBefore: false,
  hasAfter: false,
  loading: true,
  error: null,
  saveError: null,
  positionWarning: null,
};
const noopSubscribe = () => () => {};
function selectionActive() {
  return Boolean(window.getSelection()?.toString());
}
function interactive(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input,textarea,select,button,[role="slider"],[contenteditable="true"],[role="dialog"]',
      ),
    )
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isCancellationError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code === "import_cancelled";
  }
  return error instanceof Error && error.message.includes("search was cancelled");
}

function newSearchOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `search-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function highlightedText(
  text: string,
  pageStart: number,
  highlight: { start: number; end: number } | null,
) {
  if (!highlight || highlight.end <= pageStart || highlight.start >= pageStart + text.length) {
    return text;
  }
  const start = Math.max(0, highlight.start - pageStart);
  const end = Math.min(text.length, highlight.end - pageStart);
  return (
    <>
      {text.slice(0, start)}
      <mark data-testid="reader-highlight" className="rounded bg-primary/25 text-inherit">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

function safeExcerpt(text: string, maxUnits = 160): string {
  let end = Math.min(text.length, Math.max(0, maxUnits));
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function ReaderView() {
  const { activeBook, closeReader } = useApp();
  const runtime = useRuntime();
  const { state: libraryState } = useLibrary();
  const { state: settings, store: settingsStore } = useSettings();
  const reducedMotion = useReducedMotion();
  const pageBox = useRef<HTMLDivElement>(null);
  const measureBox = useRef<HTMLDivElement>(null);
  const animationBox = useRef<HTMLDivElement>(null);
  const adapter = useRef<StPageFlipAdapter | null>(null);
  const [controller, setController] = useState<ReaderController | null>(null);
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? (() => empty),
  );
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState(false);
  const [toolPanel, setToolPanel] = useState<"toc" | "bookmarks" | "search" | null>(null);
  const [tocMode, setTocMode] = useState<"auto" | "full">("auto");
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsRevision, setToolsRevision] = useState(0);
  const sessionEpoch = useRef(0);
  const failedAction = useRef<(() => Promise<void>) | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [encodingInfo, setEncodingInfo] = useState<TxtEncodingInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchCursor, setSearchCursor] = useState<number | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null);
  const [searchComplete, setSearchComplete] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const searchRequest = useRef(0);
  const searchOperationId = useRef<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftProgress, setDraftProgress] = useState<number | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const preferences = settings.value;
  useLayoutEffect(() => {
    sessionEpoch.current += 1;
    return () => {
      sessionEpoch.current += 1;
    };
  }, [activeBook?.book.id]);
  const closePanel = useCallback(() => {
    setPanel(false);
    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="排版设置"]')?.focus();
    });
  }, []);
  const closeToolPanel = useCallback(() => {
    const trigger =
      toolPanel === "toc"
        ? 'button[aria-label="目录"]'
        : toolPanel === "bookmarks"
          ? 'button[aria-label="书签"]'
          : 'button[aria-label="搜索正文"]';
    setToolPanel(null);
    queueMicrotask(() => document.querySelector<HTMLButtonElement>(trigger)?.focus());
  }, [toolPanel]);
  useEffect(() => {
    if (!activeBook) return;
    let cancelled = false;
    setToolsLoading(true);
    setToolsError(null);
    void Promise.all([
      runtime.services.library.getTxtEncoding(activeBook.book.id),
      runtime.services.reader.listToc(activeBook.book.id),
      runtime.services.reader.listBookmarks(activeBook.book.id),
    ])
      .then(([encoding, entries, saved]) => {
        if (cancelled) return;
        setEncodingInfo(encoding);
        setToc(entries);
        setBookmarks(saved);
        setToolsLoading(false);
      })
      .catch((error) => {
        if (!cancelled) {
          setToolsError(String(error));
          setToolsLoading(false);
        }
      });
    return () => {
      cancelled = true;
      setToc([]);
      setTocMode("auto");
      setBookmarks([]);
      setEncodingInfo(null);
      setSearchMatches([]);
      setSearchCursor(null);
      setSearchHasMore(false);
      setSearchComplete(false);
      setSearchError(null);
      setSearching(false);
      setHighlight(null);
      searchRequest.current += 1;
      if (searchOperationId.current) {
        void runtime.services.reader.cancelSearch(searchOperationId.current).catch(() => undefined);
        searchOperationId.current = null;
      }
    };
  }, [activeBook?.book.id, runtime.services, toolsRevision]);
  const run = useCallback((action: () => Promise<void>) => {
    const epoch = sessionEpoch.current;
    setActionError(null);
    failedAction.current = null;
    void action().catch((error) => {
      if (!isAbortError(error) && epoch === sessionEpoch.current) {
        failedAction.current = action;
        setActionError(String(error));
      }
    });
  }, []);
  const close = useCallback(async () => {
    if (closing) return;
    setClosing(true);
    try {
      await controller?.flush();
      await settingsStore.flush();
      closeReader();
      void runtime.library.refresh();
    } catch (error) {
      setActionError(String(error));
      setClosing(false);
    }
  }, [controller, closing, closeReader, runtime, settingsStore]);
  const addBookmark = useCallback(() => {
    if (!activeBook || !state.page || !state.contentWindow) return;
    const epoch = sessionEpoch.current;
    run(async () => {
      const created = await runtime.services.reader.addBookmark({
        bookId: activeBook.book.id,
        locator: state.page!.locator,
        excerpt: safeExcerpt(state.page!.text),
      });
      if (epoch !== sessionEpoch.current) return;
      setBookmarks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    });
  }, [activeBook, run, runtime.services.reader, state.contentWindow, state.page]);
  const search = useCallback(() => {
    if (!activeBook || !searchQuery.trim()) return;
    setSearchMatches([]);
    setSearchCursor(null);
    setSearchHasMore(false);
    const requestId = ++searchRequest.current;
    const operationId = newSearchOperationId();
    const previousOperationId = searchOperationId.current;
    if (previousOperationId) {
      void runtime.services.reader.cancelSearch(previousOperationId).catch(() => undefined);
    }
    searchOperationId.current = operationId;
    setSearchComplete(false);
    setSearchError(null);
    setSearching(true);
    setHighlight(null);
    run(async () => {
      try {
        const result = await runtime.services.reader.search({
          bookId: activeBook.book.id,
          query: searchQuery,
          caseSensitive: true,
          cursor: null,
          limit: 50,
          operationId,
        });
        if (requestId === searchRequest.current) {
          setSearchMatches(result.matches);
          setSearchCursor(result.nextCursor);
          setSearchHasMore(result.hasMore);
          setSearchComplete(true);
        }
      } catch (error) {
        if (requestId === searchRequest.current && !isCancellationError(error))
          setSearchError(String(error));
      } finally {
        if (requestId === searchRequest.current) {
          setSearching(false);
          if (searchOperationId.current === operationId) searchOperationId.current = null;
        }
      }
    });
  }, [activeBook, run, runtime.services.reader, searchQuery]);
  const loadMoreSearch = useCallback(() => {
    if (!activeBook || !searchQuery.trim() || !searchHasMore || searchCursor === null || searching)
      return;
    const requestId = ++searchRequest.current;
    const operationId = newSearchOperationId();
    const previousOperationId = searchOperationId.current;
    if (previousOperationId) {
      void runtime.services.reader.cancelSearch(previousOperationId).catch(() => undefined);
    }
    searchOperationId.current = operationId;
    setSearchComplete(false);
    setSearchError(null);
    setSearching(true);
    run(async () => {
      try {
        const result = await runtime.services.reader.search({
          bookId: activeBook.book.id,
          query: searchQuery,
          caseSensitive: true,
          cursor: searchCursor,
          limit: 50,
          operationId,
        });
        if (requestId === searchRequest.current) {
          setSearchMatches((current) => [...current, ...result.matches]);
          setSearchCursor(result.nextCursor);
          setSearchHasMore(result.hasMore);
          setSearchComplete(true);
        }
      } catch (error) {
        if (requestId === searchRequest.current && !isCancellationError(error))
          setSearchError(String(error));
      } finally {
        if (requestId === searchRequest.current) {
          setSearching(false);
          if (searchOperationId.current === operationId) searchOperationId.current = null;
        }
      }
    });
  }, [
    activeBook,
    run,
    runtime.services.reader,
    searchCursor,
    searchHasMore,
    searchQuery,
    searching,
  ]);
  const changeEncoding = useCallback(
    (encoding: TxtEncoding) => {
      if (!activeBook || !controller) return;
      const epoch = sessionEpoch.current;
      run(async () => {
        searchRequest.current += 1;
        if (searchOperationId.current) {
          void runtime.services.reader
            .cancelSearch(searchOperationId.current)
            .catch(() => undefined);
          searchOperationId.current = null;
        }
        setSearchComplete(false);
        setSearchError(null);
        setSearching(false);
        setSearchMatches([]);
        setSearchCursor(null);
        setSearchHasMore(false);
        setHighlight(null);
        await controller.flush();
        const next = await runtime.library.decodeTxt(activeBook.book.id, encoding);
        if (epoch !== sessionEpoch.current) return;
        setEncodingInfo(next);
        await controller.open(activeBook.book.id);
        if (epoch !== sessionEpoch.current) return;
        setToolsRevision((value) => value + 1);
        await runtime.library.refresh();
      });
    },
    [activeBook, controller, run, runtime.services.library, runtime.services.reader],
  );
  useLayoutEffect(() => {
    if (
      !activeBook ||
      !preferences ||
      !measureBox.current ||
      !pageBox.current ||
      !animationBox.current
    )
      return;
    const rect = pageBox.current.getBoundingClientRect();
    Object.assign(measureBox.current.style, {
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    const presentation = new StPageFlipAdapter(animationBox.current, {
      effect: preferences.pageTurnEffect,
      reducedMotion: Boolean(reducedMotion),
      pageClassName: "reader-prose bg-surface text-on-surface",
    });
    adapter.current = presentation;
    const reader = new ReaderController(runtime.services.reader, {
      measurer: new DomReaderMeasurer(measureBox.current),
      maxUnits: 8192,
      reducedMotion: Boolean(reducedMotion),
      adapter: presentation,
    });
    setController(reader);
    const flushReader = () => reader.flush();
    runtime.readerFlush = flushReader;
    run(() => reader.open(activeBook.book.id));
    return () => {
      reader.dispose();
      adapter.current = null;
      if (runtime.readerFlush === flushReader) runtime.readerFlush = null;
    };
  }, [activeBook?.book.id, runtime, Boolean(preferences)]);
  useEffect(() => {
    controller?.setReducedMotion(Boolean(reducedMotion));
    adapter.current?.setEffect(preferences?.pageTurnEffect ?? "instant");
  }, [controller, reducedMotion, preferences?.pageTurnEffect]);
  useLayoutEffect(() => {
    if (!controller || !pageBox.current || !measureBox.current) return;
    let frame = 0;
    let fallback = 0;
    let disposed = false;
    const reflow = () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
      let settled = false;
      const measure = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallback);
        if (disposed || !pageBox.current || !measureBox.current) return;
        const rect = pageBox.current.getBoundingClientRect();
        Object.assign(measureBox.current.style, {
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
        run(() => controller.reflow());
      };
      frame = requestAnimationFrame(measure);
      fallback = window.setTimeout(measure, 100);
    };
    const observer = new ResizeObserver(reflow);
    observer.observe(pageBox.current);
    document.fonts.addEventListener("loadingdone", reflow);
    void document.fonts.ready.then(() => {
      if (!disposed) reflow();
    });
    reflow();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", reflow);
    };
  }, [controller, preferences?.fontSize, preferences?.lineHeight, preferences?.fontFamily, run]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[data-exit-pending="true"]')) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (panel) {
          event.preventDefault();
          event.stopPropagation();
          closePanel();
          return;
        }
        if (toolPanel !== null) {
          event.preventDefault();
          event.stopPropagation();
          closeToolPanel();
          return;
        }
      }
      if (
        panel ||
        closing ||
        document.querySelector('[role="dialog"][data-open]') ||
        event.defaultPrevented ||
        interactive(event.target) ||
        selectionActive() ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        void close();
      } else if (["ArrowRight", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        if (controller) run(() => controller.next());
      } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        if (controller) run(() => controller.previous());
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [controller, panel, toolPanel, closing, run, close, closePanel, closeToolPanel]);
  if (!activeBook) return null;
  const page = state.page;
  const progress =
    page && page.totalLength ? Math.floor((page.startOffset / page.totalLength) * 100) : 0;
  const typeStyle = {
    fontSize: `${preferences?.fontSize ?? 18}px`,
    lineHeight: preferences?.lineHeight ?? 1.8,
    fontFamily:
      preferences?.fontFamily === "sans"
        ? "system-ui, sans-serif"
        : '"Literata Variable", "Noto Serif SC Variable", serif',
  };
  return (
    <div
      className="fixed inset-0 z-50 bg-surface text-on-surface flex flex-col"
      data-reader-effect={reducedMotion ? "instant" : preferences?.pageTurnEffect}
    >
      <header
        className={`fixed top-0 left-0 right-0 z-20 bg-surface/90 backdrop-blur-xl border-b border-surface-variant/30 pt-safe transition-transform duration-300 motion-reduce:transition-none ${controls ? "translate-y-0" : "-translate-y-full"}`}
        inert={!controls}
      >
        <div className="h-14 px-4 sm:px-6 flex items-center justify-between max-w-4xl mx-auto gap-2">
          <Button
            data-testid="reader-close"
            aria-label="返回书架"
            variant="ghost"
            size="icon"
            disabled={closing}
            onClick={() => void close()}
            className="h-9 w-9 text-secondary rounded-full"
          >
            <Icon name="arrow_back" size={20} />
          </Button>
          <div className="flex-1 min-w-0 text-center">
            <h1 className="font-title-editorial truncate text-sm font-semibold">
              {activeBook.book.title}
            </h1>
            <p className="text-[10px] text-secondary mt-0.5">全文</p>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-secondary rounded-full"
              aria-label="书签"
              onClick={() => setToolPanel("bookmarks")}
            >
              <Icon name="bookmark_border" size={18} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-secondary rounded-full"
              aria-label="搜索正文"
              onClick={() => setToolPanel("search")}
            >
              <Icon name="search" size={18} />
            </Button>
            <Button
              data-testid="reader-save"
              aria-label="保存进度"
              title="保存进度"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-secondary rounded-full"
              onClick={() => controller && run(() => controller.flush())}
            >
              <Icon name="save" size={18} />
            </Button>
          </div>
        </div>
      </header>
      <div className="flex-1 min-h-0 w-full max-w-2xl mx-auto px-5 sm:px-8 md:px-12 pt-20 pb-32 flex flex-col justify-between">
        <div className="flex justify-between items-center mb-4 pb-2 border-b border-surface-variant/30 text-[11px] text-secondary opacity-70 shrink-0">
          <span className="truncate">{activeBook.book.title}</span>
          <span className="shrink-0 ml-3">全文</span>
        </div>
        <div
          ref={pageBox}
          className="relative flex-1 min-h-0"
          style={typeStyle}
          onPointerDown={(event) => {
            pointer.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={(event) => {
            const start = pointer.current;
            pointer.current = null;
            if (
              !start ||
              panel ||
              toolPanel ||
              closing ||
              selectionActive() ||
              interactive(event.target) ||
              !controller
            )
              return;
            const dx = event.clientX - start.x,
              dy = event.clientY - start.y;
            if (Math.abs(dy) > 30) return;
            if (Math.abs(dx) > 60) {
              run(() => (dx < 0 ? controller.next() : controller.previous()));
              return;
            }
            if (Math.abs(dx) > 5) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const fraction = (event.clientX - rect.left) / rect.width;
            if (fraction < 0.2) run(() => controller.previous());
            else if (fraction > 0.8) run(() => controller.next());
            else setControls((value) => !value);
          }}
        >
          {page && (
            <div
              className="reader-prose reader-text h-full"
              data-testid="reader-page"
              data-book-id={state.bookId}
              data-start={page.startOffset}
              data-end={page.endOffset}
              data-total={page.totalLength}
            >
              {highlightedText(page.text, page.startOffset, highlight)}
            </div>
          )}
          {!page && state.loading && (
            <p role="status" className="text-sm text-secondary">
              正在读取正文…
            </p>
          )}
          {!state.loading && state.contentWindow?.totalLength === 0 && (
            <p className="text-sm text-secondary">这本 TXT 暂无正文。</p>
          )}
          <div
            ref={animationBox}
            data-testid="reader-animation"
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none overflow-hidden"
          />
        </div>
        <footer className="flex justify-between items-center text-[11px] text-secondary opacity-70 mt-4 pt-2 border-t border-surface-variant/30 shrink-0">
          <span>{progress}% 已读</span>
          <span>{page && !page.hasAfter ? "已到全文末尾" : ""}</span>
        </footer>
      </div>
      <div
        ref={measureBox}
        className="reader-measure reader-prose"
        aria-hidden="true"
        style={typeStyle}
      />
      {(state.error || state.saveError || actionError || settings.error) &&
        !panel &&
        !toolPanel && (
          <div
            role="alert"
            data-testid={state.saveError ? "reader-save-error" : "reader-error"}
            className="fixed bottom-32 left-4 right-4 z-30 rounded-xl px-4 py-2 bg-error-container text-error text-xs break-words"
          >
            {state.error || state.saveError || actionError || settings.error}
            <Button
              variant="outline"
              className="ml-2"
              onClick={() =>
                settings.error
                  ? preferences
                    ? settingsStore.retry()
                    : void settingsStore.load()
                  : actionError && failedAction.current
                    ? run(failedAction.current)
                    : controller &&
                      run(() =>
                        state.error ? controller.open(activeBook.book.id) : controller.flush(),
                      )
              }
            >
              重试
            </Button>
          </div>
        )}
      {state.positionWarning && !state.error && (
        <div
          role="status"
          className="fixed bottom-32 left-4 right-4 z-30 rounded-xl px-4 py-2 bg-secondary-container text-on-secondary-container text-xs"
        >
          {state.positionWarning}
        </div>
      )}
      <div
        className={`fixed bottom-0 left-0 right-0 z-20 bg-surface/90 backdrop-blur-xl pb-safe border-t border-surface-variant/30 transition-transform duration-300 motion-reduce:transition-none ${controls ? "translate-y-0" : "translate-y-full"}`}
        inert={!controls}
      >
        <div className="max-w-xl mx-auto px-4 sm:px-6 py-3 space-y-3">
          <div className="flex items-center gap-3">
            <Button
              data-testid="reader-previous"
              variant="ghost"
              size="sm"
              className="text-xs text-secondary hover:text-on-surface h-7 px-2 bg-surface-container shrink-0"
              disabled={!state.hasBefore || closing}
              onClick={() => controller && run(() => controller.previous())}
            >
              上一页
            </Button>
            <Slider
              data-testid="reader-progress"
              aria-label="阅读进度"
              className="flex-1"
              min={0}
              max={100}
              step={1}
              disabled={!page || !page.totalLength}
              value={draftProgress ?? progress}
              onValueChange={(value) => setDraftProgress(Array.isArray(value) ? value[0] : value)}
              onValueCommitted={(value) => {
                const target = Array.isArray(value) ? value[0] : value;
                setDraftProgress(null);
                if (controller) run(() => controller.seekProgress(target / 100));
              }}
            />
            <span className="text-[11px] text-secondary tabular-nums w-9 text-right">
              {draftProgress ?? progress}%
            </span>
            <Button
              data-testid="reader-next"
              variant="ghost"
              size="sm"
              className="text-xs text-secondary hover:text-on-surface h-7 px-2 bg-surface-container shrink-0"
              disabled={!state.hasAfter || closing}
              onClick={() => controller && run(() => controller.next())}
            >
              下一页
            </Button>
          </div>
          <div className="flex items-center justify-around">
            <Button
              variant="ghost"
              aria-label="目录"
              className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1 px-3 text-xs gap-1"
              onClick={() => setToolPanel("toc")}
            >
              <Icon name="list" size={20} />
              目录
            </Button>
            <Button
              variant="ghost"
              aria-label="排版设置"
              className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1 px-3 text-xs gap-1"
              onClick={() => setPanel(true)}
            >
              <Icon name="format_size" size={20} />
              排版
            </Button>
            <Button
              variant="ghost"
              aria-label="切换日夜模式"
              className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1 px-3 text-xs gap-1"
              disabled={!preferences}
              onClick={() =>
                settingsStore.set({
                  theme: document.documentElement.classList.contains("dark") ? "light" : "dark",
                })
              }
            >
              <Icon name="dark_mode" size={20} />
              {document.documentElement.classList.contains("dark") ? "白天" : "夜间"}
            </Button>
            <Button
              variant="ghost"
              aria-label="添加书签"
              className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1 px-3 text-xs gap-1"
              onClick={addBookmark}
              disabled={!page || closing}
            >
              <Icon name="bookmark_border" size={20} />
              加书签
            </Button>
          </div>
        </div>
      </div>
      {panel && (
        <Dialog open onOpenChange={(open) => !open && closePanel()}>
          <DialogContent
            className="bg-surface/95 backdrop-blur-xl border border-surface-variant/50 w-[calc(100%-2rem)] max-w-sm rounded-2xl p-4 sm:p-5 shadow-2xl overflow-y-auto top-auto bottom-24 translate-y-0"
            style={{ maxHeight: "calc(100dvh - 8rem)" }}
          >
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-sm">排版与纸张微调</DialogTitle>
              <DialogDescription className="sr-only">
                调整排版会保留当前阅读位置。TXT 目录、书签和搜索均绑定当前正文版本。
              </DialogDescription>
            </DialogHeader>
            {actionError && (
              <div role="alert" className="text-xs text-error space-y-2">
                <p>{actionError}</p>
                {failedAction.current && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => failedAction.current && run(failedAction.current)}
                  >
                    重试操作
                  </Button>
                )}
              </div>
            )}
            {toolsLoading && (
              <p role="status" className="text-xs text-secondary">
                正在读取书籍信息…
              </p>
            )}
            {toolsError && (
              <div role="alert" className="text-xs text-error">
                <p>{toolsError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setToolsRevision((value) => value + 1)}
                >
                  重新加载
                </Button>
              </div>
            )}
            {preferences && (
              <div className="space-y-4 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-secondary font-medium">字号大小</span>
                  <div className="flex items-center gap-2">
                    <Button
                      aria-label="减小字号"
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        settingsStore.set({ fontSize: Math.max(14, preferences.fontSize - 1) })
                      }
                      className="h-7 px-2.5 bg-surface-container font-medium text-xs"
                    >
                      A-
                    </Button>
                    <span className="w-8 text-center text-primary font-semibold">
                      {preferences.fontSize}px
                    </span>
                    <Button
                      aria-label="增大字号"
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        settingsStore.set({ fontSize: Math.min(32, preferences.fontSize + 1) })
                      }
                      className="h-7 px-2.5 bg-surface-container font-medium text-xs"
                    >
                      A+
                    </Button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-secondary">行距</span>
                  <div className="flex gap-1.5">
                    {[1.6, 1.8, 2].map((height) => (
                      <Button
                        key={height}
                        variant="secondary"
                        size="sm"
                        aria-pressed={preferences.lineHeight === height}
                        className={`h-7 px-2 text-xs ${preferences.lineHeight === height ? "bg-primary text-on-primary" : "bg-surface-container text-secondary"}`}
                        onClick={() => settingsStore.set({ lineHeight: height })}
                      >
                        {height}x
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {(["warm-tea", "bone-white", "xuan-paper", "jade-green"] as const).map(
                    (tone, index) => (
                      <button
                        key={tone}
                        aria-label={["柔雅暖茶", "羊脂白", "宣纸微黄", "墨绿温润"][index]}
                        aria-pressed={preferences.paperTone === tone}
                        onClick={() => settingsStore.set({ paperTone: tone })}
                        className={`h-8 rounded-lg border border-black/10 flex items-center justify-center ${preferences.paperTone === tone ? "ring-2 ring-primary" : ""}`}
                        style={{ background: ["#f6f2e9", "#faf8f5", "#f3ece0", "#e7ebe4"][index] }}
                      >
                        {preferences.paperTone === tone && (
                          <Icon name="check" size={14} className="text-primary" />
                        )}
                      </button>
                    ),
                  )}
                </div>
                <details className="border-t border-surface-variant/30 pt-3 space-y-2">
                  <summary className="text-xs text-secondary cursor-pointer">
                    字体与文本编码
                  </summary>
                  <div className="grid grid-cols-2 gap-2">
                    {(["serif", "sans"] as const).map((font) => (
                      <Button
                        key={font}
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        aria-pressed={preferences.fontFamily === font}
                        onClick={() => settingsStore.set({ fontFamily: font })}
                      >
                        {font === "serif" ? "思源宋体" : "系统黑体"}
                      </Button>
                    ))}
                  </div>
                  <label htmlFor="reader-encoding" className="block text-sm">
                    文本编码
                  </label>
                  <select
                    id="reader-encoding"
                    className="w-full rounded-lg border border-surface-variant bg-surface-container px-3 py-2"
                    value={encodingInfo?.selected ?? "auto"}
                    disabled={!encodingInfo?.canChange || libraryState.decoding}
                    onChange={(event) => changeEncoding(event.target.value as TxtEncoding)}
                  >
                    <option value="auto">自动识别</option>
                    <option value="utf8">UTF-8</option>
                    <option value="gb18030">GB18030</option>
                    <option value="gbk">GBK</option>
                    <option value="utf16_le">UTF-16 LE</option>
                    <option value="utf16_be">UTF-16 BE</option>
                  </select>
                  {encodingInfo?.state === "replacement_characters" && (
                    <p className="text-xs text-error">当前编码包含替换字符，请尝试其他编码。</p>
                  )}
                  {encodingInfo && !encodingInfo.canChange && (
                    <div className="space-y-2">
                      <p className="text-xs text-secondary">
                        旧书籍没有保留原始字节。选择原始 TXT 并完成校验后即可切换编码。
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          run(async () => {
                            const next = await runtime.services.library.pickAndReassociateTxt(
                              activeBook.book.id,
                            );
                            if (next) setEncodingInfo(next);
                          })
                        }
                      >
                        关联原始 TXT
                      </Button>
                    </div>
                  )}
                  {libraryState.decoding && (
                    <div className="flex items-center justify-between gap-3">
                      <p role="status" className="text-xs text-secondary">
                        正在重建正文缓存…
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void runtime.library.cancelDecode()}
                      >
                        取消转换
                      </Button>
                    </div>
                  )}
                  {libraryState.decodeError && (
                    <p role="alert" className="text-xs text-error">
                      {libraryState.decodeError}
                    </p>
                  )}
                </details>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
      {toolPanel !== null && (
        <Dialog open onOpenChange={(open) => !open && closeToolPanel()}>
          <DialogContent className="bg-surface border border-surface-variant/40 rounded-2xl sm:max-w-md max-h-[72dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {toolPanel === "toc" ? "目录" : toolPanel === "bookmarks" ? "书签" : "搜索正文"}
              </DialogTitle>
              <DialogDescription>
                {toolPanel === "toc"
                  ? "自动识别的章节标题"
                  : toolPanel === "bookmarks"
                    ? "保存当前位置，方便稍后继续阅读"
                    : "在当前 TXT 中查找文字"}
              </DialogDescription>
            </DialogHeader>
            {actionError && (
              <div role="alert" className="text-xs text-error space-y-2">
                <p>{actionError}</p>
                {failedAction.current && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => failedAction.current && run(failedAction.current)}
                  >
                    重试操作
                  </Button>
                )}
              </div>
            )}
            {toolsLoading && (
              <p role="status" className="text-xs text-secondary">
                正在读取书籍信息…
              </p>
            )}
            {toolsError && (
              <div role="alert" className="text-xs text-error">
                <p>{toolsError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setToolsRevision((value) => value + 1)}
                >
                  重新加载
                </Button>
              </div>
            )}
            {toolPanel === "toc" && (
              <div className="space-y-3">
                <div className="flex gap-2" role="tablist" aria-label="目录模式">
                  <Button
                    variant={tocMode === "auto" ? "secondary" : "ghost"}
                    role="tab"
                    aria-selected={tocMode === "auto"}
                    onClick={() => setTocMode("auto")}
                  >
                    自动识别
                  </Button>
                  <Button
                    variant={tocMode === "full" ? "secondary" : "ghost"}
                    role="tab"
                    aria-selected={tocMode === "full"}
                    onClick={() => setTocMode("full")}
                  >
                    全文
                  </Button>
                </div>
                <div className="max-h-80 overflow-auto space-y-1">
                  {tocMode === "full" ? (
                    <Button
                      variant="ghost"
                      className="w-full justify-start"
                      onClick={() => {
                        closeToolPanel();
                        if (controller) run(() => controller.seekProgress(0));
                      }}
                    >
                      从开头阅读
                    </Button>
                  ) : (
                    <>
                      {toc.length === 0 && !toolsLoading && !toolsError && (
                        <p className="text-sm text-secondary">未识别到章节，全文阅读。</p>
                      )}
                      {toc.map((entry) => (
                        <Button
                          key={`${entry.ordinal}-${entry.locator.offset}`}
                          variant="ghost"
                          className="w-full justify-start"
                          onClick={() => {
                            closeToolPanel();
                            if (controller) run(() => controller.seek(entry.locator));
                          }}
                        >
                          {entry.title}
                        </Button>
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}
            {toolPanel === "bookmarks" && (
              <div className="max-h-80 overflow-auto space-y-2">
                {bookmarks.length === 0 && !toolsLoading && !toolsError && (
                  <p className="text-sm text-secondary">还没有书签。</p>
                )}
                {bookmarks.map((bookmark) => (
                  <div key={bookmark.id} className="flex gap-2 items-start">
                    <Button
                      variant="ghost"
                      className="flex-1 justify-start text-left h-auto whitespace-normal"
                      onClick={() => {
                        if (bookmark.contentVersion !== state.contentWindow?.contentVersion) {
                          setActionError("该书签属于旧正文版本，请从目录或全文重新定位。");
                          return;
                        }
                        closeToolPanel();
                        if (controller) run(() => controller.seek(bookmark.locator));
                      }}
                    >
                      <span>
                        {bookmark.excerpt || "当前位置"}
                        {bookmark.contentVersion !== state.contentWindow?.contentVersion && (
                          <span className="block text-xs text-secondary mt-1">
                            旧版本书签 · 待重新定位
                          </span>
                        )}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label="删除书签"
                      onClick={() =>
                        run(async () => {
                          await runtime.services.reader.deleteBookmark({ bookmarkId: bookmark.id });
                          setBookmarks((current) =>
                            current.filter((item) => item.id !== bookmark.id),
                          );
                        })
                      }
                    >
                      删除
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {toolPanel === "search" && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    autoFocus
                    aria-label="搜索关键词"
                    className="flex-1 rounded-lg border border-surface-variant bg-surface-container px-3 py-2"
                    value={searchQuery}
                    onChange={(event) => {
                      searchRequest.current += 1;
                      if (searchOperationId.current) {
                        void runtime.services.reader
                          .cancelSearch(searchOperationId.current)
                          .catch(() => undefined);
                        searchOperationId.current = null;
                      }
                      setSearchComplete(false);
                      setSearchError(null);
                      setSearching(false);
                      setSearchMatches([]);
                      setSearchCursor(null);
                      setSearchHasMore(false);
                      setHighlight(null);
                      setSearchQuery(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") search();
                    }}
                  />
                  <Button onClick={search} disabled={searching || !searchQuery.trim()}>
                    搜索
                  </Button>
                </div>
                {searching && (
                  <p role="status" className="text-sm text-secondary">
                    正在搜索…
                  </p>
                )}
                {searchError && (
                  <div role="alert" className="text-sm text-error">
                    {searchError}
                    <Button size="sm" variant="outline" onClick={search}>
                      重试搜索
                    </Button>
                  </div>
                )}
                {searchComplete && !searchError && searchMatches.length === 0 && !searching && (
                  <p className="text-sm text-secondary">没有找到匹配内容。</p>
                )}
                <div className="max-h-64 overflow-auto space-y-1">
                  {searchMatches.map((match) => (
                    <Button
                      key={`${match.ordinal}-${match.locator.offset}`}
                      variant="ghost"
                      className="w-full justify-start text-left h-auto whitespace-normal"
                      onClick={() => {
                        setHighlight({ start: match.matchStart, end: match.matchEnd });
                        closeToolPanel();
                        if (controller) run(() => controller.seek(match.locator));
                      }}
                    >
                      {match.excerpt}
                    </Button>
                  ))}
                </div>
                {searchHasMore && (
                  <Button variant="outline" onClick={loadMoreSearch} disabled={searching}>
                    {searching ? "正在搜索…" : "加载更多"}
                  </Button>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

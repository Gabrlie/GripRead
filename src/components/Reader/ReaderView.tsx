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
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [encodingInfo, setEncodingInfo] = useState<TxtEncodingInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchCursor, setSearchCursor] = useState<number | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const searchRequest = useRef(0);
  const searchOperationId = useRef<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftProgress, setDraftProgress] = useState<number | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const preferences = settings.value;
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
      })
      .catch((error) => {
        if (!cancelled) setActionError(String(error));
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
      setSearching(false);
      setHighlight(null);
      searchRequest.current += 1;
      if (searchOperationId.current) {
        void runtime.services.reader.cancelSearch(searchOperationId.current).catch(() => undefined);
        searchOperationId.current = null;
      }
    };
  }, [activeBook?.book.id, runtime.services]);
  const run = useCallback((action: () => Promise<void>) => {
    setActionError(null);
    void action().catch((error) => {
      if (!isAbortError(error)) setActionError(String(error));
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
    run(async () => {
      const created = await runtime.services.reader.addBookmark({
        bookId: activeBook.book.id,
        locator: state.page!.locator,
        excerpt: safeExcerpt(state.page!.text),
      });
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
        }
      } catch (error) {
        if (requestId === searchRequest.current && !isCancellationError(error)) throw error;
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
        }
      } catch (error) {
        if (requestId === searchRequest.current && !isCancellationError(error)) throw error;
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
      run(async () => {
        searchRequest.current += 1;
        if (searchOperationId.current) {
          await runtime.services.reader
            .cancelSearch(searchOperationId.current)
            .catch(() => undefined);
          searchOperationId.current = null;
        }
        setSearching(false);
        setSearchMatches([]);
        setSearchCursor(null);
        setSearchHasMore(false);
        setHighlight(null);
        await controller.flush();
        const next = await runtime.library.decodeTxt(activeBook.book.id, encoding);
        setEncodingInfo(next);
        setToc(await runtime.services.reader.listToc(activeBook.book.id));
        await runtime.library.refresh();
        await controller.open(activeBook.book.id);
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
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (panel) {
          closePanel();
          return;
        }
        if (toolPanel !== null) {
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
    fontSize: `${preferences?.fontSize ?? 20}px`,
    lineHeight: preferences?.lineHeight ?? 1.8,
    fontFamily:
      preferences?.fontFamily === "sans"
        ? "system-ui, sans-serif"
        : '"Songti SC", "SimSun", Georgia, serif',
  };
  return (
    <div
      className="fixed inset-0 z-50 bg-surface text-on-surface flex flex-col"
      data-reader-effect={reducedMotion ? "instant" : preferences?.pageTurnEffect}
    >
      <header
        className={`h-14 shrink-0 px-4 flex items-center justify-between border-b border-surface-variant/30 ${controls ? "" : "invisible"}`}
        inert={!controls}
      >
        <Button
          data-testid="reader-close"
          variant="ghost"
          disabled={closing}
          onClick={() => void close()}
        >
          <Icon name="arrow_back" size={18} />
          返回
        </Button>
        <h1 className="font-title-editorial truncate text-sm px-3">{activeBook.book.title}</h1>
        <div className="flex items-center gap-1">
          <Button variant="ghost" aria-label="目录" onClick={() => setToolPanel("toc")}>
            <Icon name="auto_stories" />
          </Button>
          <Button variant="ghost" aria-label="书签" onClick={() => setToolPanel("bookmarks")}>
            <Icon name="bookmark" />
          </Button>
          <Button variant="ghost" aria-label="搜索正文" onClick={() => setToolPanel("search")}>
            <Icon name="search" />
          </Button>
        </div>
        <Button
          data-testid="reader-save"
          variant="ghost"
          onClick={() => controller && run(() => controller.flush())}
        >
          保存进度
        </Button>
      </header>
      <div className="flex-1 min-h-0 w-full max-w-[768px] mx-auto px-6 py-5 sm:px-8 flex flex-col">
        <div className="text-xs text-secondary flex justify-between mb-3 shrink-0">
          <span className="truncate">{activeBook.book.title}</span>
          <span>全文</span>
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
        <footer className="flex justify-between text-xs text-secondary pt-3 shrink-0">
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
      {(state.error || state.saveError || actionError || settings.error) && (
        <div
          role="alert"
          data-testid={state.saveError ? "reader-save-error" : "reader-error"}
          className="shrink-0 px-4 py-2 bg-error-container text-error text-xs break-words"
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
          className="shrink-0 px-4 py-2 bg-secondary-container text-on-secondary-container text-xs"
        >
          {state.positionWarning}
        </div>
      )}
      <div
        className={`shrink-0 px-4 py-3 border-t border-surface-variant/30 ${controls ? "" : "invisible"}`}
        inert={!controls}
      >
        <div className="max-w-xl mx-auto flex items-center gap-3">
          <Button
            data-testid="reader-previous"
            variant="outline"
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
          <Button
            data-testid="reader-next"
            variant="outline"
            disabled={!state.hasAfter || closing}
            onClick={() => controller && run(() => controller.next())}
          >
            下一页
          </Button>
          <Button
            variant="ghost"
            aria-label="添加书签"
            onClick={addBookmark}
            disabled={!page || closing}
          >
            <Icon name="bookmark" />
          </Button>
          <Button variant="ghost" aria-label="排版设置" onClick={() => setPanel(true)}>
            <Icon name="format_size" />
          </Button>
        </div>
      </div>
      {panel && (
        <Dialog open onOpenChange={(open) => !open && closePanel()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>排版</DialogTitle>
              <DialogDescription>
                调整排版会保留当前阅读位置。TXT 目录、书签和搜索均绑定当前正文版本。
              </DialogDescription>
            </DialogHeader>
            {preferences && (
              <div className="space-y-5">
                <label className="block">字号：{preferences.fontSize}px</label>
                <Slider
                  aria-label="字号"
                  value={preferences.fontSize}
                  min={14}
                  max={32}
                  step={1}
                  onValueChange={(value) =>
                    settingsStore.set({ fontSize: Array.isArray(value) ? value[0] : value })
                  }
                />
                <label className="block">行高：{preferences.lineHeight.toFixed(1)}</label>
                <Slider
                  aria-label="行高"
                  value={preferences.lineHeight}
                  min={1.2}
                  max={2.4}
                  step={0.1}
                  onValueChange={(value) =>
                    settingsStore.set({ lineHeight: Array.isArray(value) ? value[0] : value })
                  }
                />
                <Button
                  variant="outline"
                  onClick={() =>
                    settingsStore.set({
                      fontFamily: preferences.fontFamily === "serif" ? "sans" : "serif",
                    })
                  }
                >
                  {preferences.fontFamily === "serif" ? "切换系统字体" : "切换衬线字体"}
                </Button>
                <div className="border-t border-surface-variant/30 pt-4 space-y-2">
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
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
      {toolPanel !== null && (
        <Dialog open onOpenChange={(open) => !open && closeToolPanel()}>
          <DialogContent>
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
                      {toc.length === 0 && (
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
                {bookmarks.length === 0 && <p className="text-sm text-secondary">还没有书签。</p>}
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
                      {bookmark.excerpt || "当前位置"}
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
                {searchMatches.length === 0 && searchQuery && !searching && (
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

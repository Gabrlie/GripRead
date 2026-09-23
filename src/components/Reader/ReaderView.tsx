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
import { useAutomaticTurn } from "./use-automatic-turn";
import { ReaderController, DomReaderMeasurer, StPageFlipAdapter } from "../../reader";
import type { ReaderSnapshot } from "../../reader";
import type {
  Bookmark,
  SearchMatch,
  TocEntry,
  TxtEncoding,
  TxtEncodingInfo,
  TxtTocRule,
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
  const [controls, setControls] = useState(false);
  const [panel, setPanel] = useState<
    "settings" | "directory" | "encoding" | "more" | "search" | "contents" | "automatic" | null
  >(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [tocMode, setTocMode] = useState<"auto" | "full">("auto");
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsRevision, setToolsRevision] = useState(0);
  const sessionEpoch = useRef(0);
  const failedAction = useRef<(() => Promise<void>) | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocRule, setTocRule] = useState<TxtTocRule>({ mode: "automatic", pattern: "" });
  const [ruleDraft, setRuleDraft] = useState<TxtTocRule>({ mode: "automatic", pattern: "" });
  const [rulePreview, setRulePreview] = useState<TocEntry[] | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  const ruleRequest = useRef(0);
  const ruleOperation = useRef<"preview" | "save" | null>(null);
  const pendingRuleSave = useRef<Promise<TxtTocRule> | null>(null);
  const failedRuleSave = useRef<{ bookId: string; rule: TxtTocRule } | null>(null);
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
  const automaticTurn = useAutomaticTurn({
    intervalSeconds: preferences?.autoPageSeconds ?? 8,
    canContinue: () => {
      const current = controller?.getSnapshot();
      return Boolean(
        current?.hasAfter &&
        !current.loading &&
        !current.error &&
        !current.saveError &&
        !closing &&
        !libraryState.decoding &&
        !selectionActive() &&
        !document.querySelector('[data-exit-pending="true"]'),
      );
    },
    turn: () => controller?.next() ?? Promise.resolve(),
  });
  const cancelSearch = useCallback(() => {
    searchRequest.current += 1;
    if (searchOperationId.current) {
      void runtime.services.reader.cancelSearch(searchOperationId.current).catch(() => undefined);
      searchOperationId.current = null;
    }
    setSearching(false);
  }, [runtime.services.reader]);
  const closePanel = useCallback(() => {
    const previous = panel;
    if (previous === "directory" && ruleOperation.current === "preview") {
      ruleRequest.current += 1;
      ruleOperation.current = null;
      setRuleBusy(false);
    }
    if (previous === "search") cancelSearch();
    setPanel(null);
    queueMicrotask(() => {
      const labels: Record<Exclude<typeof panel, null>, string> = {
        settings: "设置",
        directory: "目录规则",
        encoding: "编码格式",
        more: "更多",
        search: "搜索正文",
        contents: "目录",
        automatic: "自动翻页",
      };
      document
        .querySelector<HTMLButtonElement>(`button[aria-label="${labels[previous ?? "settings"]}"]`)
        ?.focus();
    });
  }, [cancelSearch, panel]);
  const openPanel = useCallback(
    (next: NonNullable<typeof panel>) => {
      automaticTurn.pause();
      setControls(true);
      setPanel(next);
    },
    [automaticTurn.pause],
  );
  useEffect(() => {
    if (!activeBook) return;
    let cancelled = false;
    ruleRequest.current += 1;
    ruleOperation.current = null;
    setRuleBusy(false);
    setRuleDraft({ mode: "automatic", pattern: "" });
    setRulePreview(null);
    setRuleError(null);
    setToolsLoading(true);
    setToolsError(null);
    void Promise.all([
      runtime.services.library.getTxtEncoding(activeBook.book.id),
      runtime.services.reader.listToc(activeBook.book.id),
      runtime.services.reader.listBookmarks(activeBook.book.id),
      runtime.services.reader.getTocRule(activeBook.book.id),
    ])
      .then(([encoding, entries, saved, rule]) => {
        if (cancelled) return;
        setEncodingInfo(encoding);
        setToc(entries);
        setBookmarks(saved);
        setTocRule(rule);
        setRuleDraft(rule);
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
      ruleRequest.current += 1;
      setToc([]);
      setRulePreview(null);
      setRuleError(null);
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
      cancelSearch();
    };
  }, [activeBook?.book.id, cancelSearch, runtime.services, toolsRevision]);
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
  const saveDirectoryRule = useCallback(
    (bookId: string, rule: TxtTocRule) => {
      const epoch = sessionEpoch.current;
      const saving = Promise.resolve()
        .then(() => runtime.services.reader.saveTocRule({ bookId, rule }))
        .then(
          (saved) => {
            failedRuleSave.current = null;
            runtime.shelf.invalidateChapterCache(bookId);
            if (epoch === sessionEpoch.current) {
              setTocRule(saved);
              setRuleDraft(saved);
              setToc([]);
              setRulePreview(null);
            }
            return saved;
          },
          (error: unknown) => {
            failedRuleSave.current = { bookId, rule };
            throw error;
          },
        )
        .finally(() => {
          if (pendingRuleSave.current === saving) pendingRuleSave.current = null;
        });
      pendingRuleSave.current = saving;
      return saving;
    },
    [runtime],
  );
  const flushDirectory = useCallback(async () => {
    if (pendingRuleSave.current) {
      await pendingRuleSave.current;
      return;
    }
    const failed = failedRuleSave.current;
    if (failed) {
      await saveDirectoryRule(failed.bookId, failed.rule);
      setRuleError(null);
      setActionError(null);
      setToolsRevision((value) => value + 1);
    }
  }, [saveDirectoryRule]);
  const close = useCallback(async () => {
    if (closing) return;
    setClosing(true);
    try {
      await automaticTurn.pause();
      await flushDirectory();
      await controller?.flush();
      await settingsStore.flush();
      closeReader();
      void runtime.library.refresh();
    } catch (error) {
      setActionError(String(error));
      setClosing(false);
    }
  }, [
    automaticTurn.pause,
    controller,
    closing,
    closeReader,
    flushDirectory,
    runtime,
    settingsStore,
  ]);
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
  const previewDirectory = useCallback(async () => {
    if (ruleOperation.current !== null || toolsLoading || toolsError) return;
    if (!activeBook || (ruleDraft.mode === "custom" && !ruleDraft.pattern.trim())) {
      setRuleError("请先填写自定义正则规则。");
      return;
    }
    const request = ++ruleRequest.current;
    const epoch = sessionEpoch.current;
    ruleOperation.current = "preview";
    setRuleBusy(true);
    setRuleError(null);
    setRulePreview(null);
    try {
      const preview = await runtime.services.reader.previewTocRule({
        bookId: activeBook.book.id,
        rule: ruleDraft,
      });
      if (epoch === sessionEpoch.current && request === ruleRequest.current)
        setRulePreview(preview.entries);
    } catch (error) {
      if (epoch === sessionEpoch.current && request === ruleRequest.current)
        setRuleError(String(error));
    } finally {
      if (epoch === sessionEpoch.current && request === ruleRequest.current) {
        ruleOperation.current = null;
        setRuleBusy(false);
      }
    }
  }, [activeBook, ruleDraft, runtime.services.reader, toolsError, toolsLoading]);
  const persistDirectory = useCallback(
    async (rule: TxtTocRule) => {
      if (!activeBook || ruleOperation.current !== null || toolsLoading || toolsError) return;
      const request = ++ruleRequest.current;
      const epoch = sessionEpoch.current;
      ruleOperation.current = "save";
      setRuleBusy(true);
      setRuleError(null);
      setActionError(null);
      failedAction.current = null;
      let savedSuccessfully = false;
      try {
        await saveDirectoryRule(activeBook.book.id, rule);
        if (epoch !== sessionEpoch.current || request !== ruleRequest.current) return;
        savedSuccessfully = true;
        const entries = await runtime.services.reader.listToc(activeBook.book.id);
        if (epoch !== sessionEpoch.current || request !== ruleRequest.current) return;
        setToc(entries);
        await runtime.shelf.load(libraryState.books);
      } catch (error) {
        if (epoch === sessionEpoch.current && request === ruleRequest.current) {
          if (savedSuccessfully) setToolsError(`规则已保存，目录读取失败：${String(error)}`);
          else {
            setRuleError(String(error));
            if (panelRef.current !== "directory") {
              setActionError(`目录规则保存失败：${String(error)}`);
              failedAction.current = () => persistDirectory(rule);
            }
          }
        }
      } finally {
        if (epoch === sessionEpoch.current && request === ruleRequest.current) {
          ruleOperation.current = null;
          setRuleBusy(false);
        }
      }
    },
    [activeBook, libraryState.books, runtime, saveDirectoryRule, toolsError, toolsLoading],
  );
  const applyDirectory = useCallback(() => {
    if (rulePreview !== null) void persistDirectory(ruleDraft);
  }, [persistDirectory, ruleDraft, rulePreview]);
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
      if (!activeBook || !controller || ruleOperation.current === "save") return;
      const epoch = sessionEpoch.current;
      void automaticTurn.pause();
      ruleRequest.current += 1;
      ruleOperation.current = null;
      setRuleBusy(false);
      setRulePreview(null);
      run(async () => {
        cancelSearch();
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
    [activeBook, automaticTurn.pause, cancelSearch, controller, run, runtime],
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
    const flushReader = async () => {
      await automaticTurn.pause();
      await flushDirectory();
      await reader.flush();
    };
    runtime.readerFlush = flushReader;
    run(() => reader.open(activeBook.book.id));
    return () => {
      reader.dispose();
      adapter.current = null;
      if (runtime.readerFlush === flushReader) runtime.readerFlush = null;
    };
  }, [activeBook?.book.id, automaticTurn.pause, flushDirectory, runtime, Boolean(preferences)]);
  useEffect(() => {
    void automaticTurn.pause();
  }, [activeBook?.book.id, state.contentWindow?.contentVersion, automaticTurn.pause]);
  useEffect(() => {
    if (state.error || state.saveError || libraryState.decoding) void automaticTurn.pause();
  }, [state.error, state.saveError, libraryState.decoding, automaticTurn.pause]);
  useEffect(() => {
    controller?.setReducedMotion(Boolean(reducedMotion));
    adapter.current?.setEffect(preferences?.pageTurnEffect ?? "instant");
  }, [controller, reducedMotion, preferences?.pageTurnEffect]);
  useEffect(() => {
    if (!automaticTurn.running) return;
    const pauseForSelection = () => {
      if (selectionActive()) automaticTurn.pause();
    };
    document.addEventListener("selectionchange", pauseForSelection);
    return () => document.removeEventListener("selectionchange", pauseForSelection);
  }, [automaticTurn.running, automaticTurn.pause]);
  useLayoutEffect(() => {
    if (!controller || !pageBox.current || !measureBox.current) return;
    let frame = 0;
    let fallback = 0;
    let disposed = false;
    const reflow = () => {
      automaticTurn.pause();
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
  }, [
    automaticTurn.pause,
    controller,
    preferences?.fontSize,
    preferences?.lineHeight,
    preferences?.fontFamily,
    run,
  ]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[data-exit-pending="true"]')) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (panel !== null) {
          event.preventDefault();
          event.stopPropagation();
          closePanel();
          return;
        }
      }
      if (
        panel !== null ||
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
        if (controller) {
          automaticTurn.pause();
          run(() => controller.next());
        }
      } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        if (controller) {
          automaticTurn.pause();
          run(() => controller.previous());
        }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [controller, panel, closing, run, close, closePanel, automaticTurn]);
  if (!activeBook) return null;
  const page = state.page;
  const progress =
    page && page.totalLength ? Math.floor((page.startOffset / page.totalLength) * 100) : 0;
  const totalLength = state.contentWindow?.totalLength ?? activeBook.totalLength;
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
      inert={closing}
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
              aria-label="目录规则"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-secondary rounded-full"
              onClick={() => openPanel("directory")}
            >
              <Icon name="import_contacts" size={18} />
            </Button>
            <Button
              aria-label="编码格式"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-secondary rounded-full"
              onClick={() => openPanel("encoding")}
            >
              <Icon name="tune" size={18} />
            </Button>
            <Button
              aria-label="更多"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-secondary rounded-full"
              onClick={() => openPanel("more")}
            >
              <Icon name="more_horiz" size={18} />
            </Button>
          </div>
        </div>
      </header>
      <div className="absolute inset-0 w-full max-w-2xl mx-auto px-5 sm:px-8 md:px-12 pt-safe pb-safe overflow-hidden">
        <div
          ref={pageBox}
          className="relative h-full min-h-0 w-full"
          style={typeStyle}
          onPointerDown={(event) => {
            void automaticTurn.pause();
            pointer.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={(event) => {
            const start = pointer.current;
            pointer.current = null;
            if (
              !start ||
              panel !== null ||
              closing ||
              selectionActive() ||
              interactive(event.target) ||
              !controller
            )
              return;
            const dx = event.clientX - start.x,
              dy = event.clientY - start.y;
            if (Math.abs(dy) > 30) {
              automaticTurn.pause();
              return;
            }
            if (Math.abs(dx) > 60) {
              automaticTurn.pause();
              run(() => (dx < 0 ? controller.next() : controller.previous()));
              return;
            }
            if (Math.abs(dx) > 5) return;
            automaticTurn.pause();
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
      </div>
      <div
        ref={measureBox}
        className="reader-measure reader-prose"
        aria-hidden="true"
        style={typeStyle}
      />
      {(state.error || state.saveError || actionError || settings.error) && panel === null && (
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
              onClick={() => {
                automaticTurn.pause();
                if (controller) run(() => controller.previous());
              }}
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
              onValueChange={(value) => {
                automaticTurn.pause();
                setDraftProgress(Array.isArray(value) ? value[0] : value);
              }}
              onValueCommitted={(value) => {
                automaticTurn.pause();
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
              onClick={() => {
                automaticTurn.pause();
                if (controller) run(() => controller.next());
              }}
            >
              下一页
            </Button>
          </div>
          <div className="flex items-center justify-around">
            <Button
              variant="ghost"
              aria-label="搜索正文"
              className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1 px-3 text-xs gap-1"
              onClick={() => openPanel("search")}
            >
              <Icon name="search" size={20} />
              搜索
            </Button>
            <Button
              variant="ghost"
              aria-label="自动翻页"
              className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1 px-3 text-xs gap-1"
              onClick={() => openPanel("automatic")}
            >
              <Icon name="schedule" size={20} />
              自动翻页
            </Button>
            <Button
              variant="ghost"
              aria-label="目录"
              className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1 px-3 text-xs gap-1"
              onClick={() => openPanel("contents")}
            >
              <Icon name="list" size={20} />
              目录
            </Button>
            <Button
              variant="ghost"
              aria-label="设置"
              className="flex flex-col items-center text-secondary hover:text-primary h-auto py-1 px-3 text-xs gap-1"
              onClick={() => openPanel("settings")}
            >
              <Icon name="format_size" size={20} />
              设置
            </Button>
          </div>
        </div>
      </div>
      {panel === "settings" && (
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
                <div className="space-y-2">
                  <span className="text-secondary font-medium">界面主题</span>
                  <div className="grid grid-cols-3 gap-2">
                    {(["system", "light", "dark"] as const).map((theme) => (
                      <Button
                        key={theme}
                        variant="outline"
                        size="sm"
                        aria-pressed={preferences.theme === theme}
                        onClick={() => settingsStore.set({ theme })}
                      >
                        {{ system: "跟随系统", light: "日间", dark: "夜间" }[theme]}
                      </Button>
                    ))}
                  </div>
                </div>
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
                <div className="border-t border-surface-variant/30 pt-3 space-y-2">
                  <span className="text-xs text-secondary">字体</span>
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
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
      {panel !== null && panel !== "settings" && (
        <Dialog open onOpenChange={(open) => !open && closePanel()}>
          <DialogContent className="bg-surface border border-surface-variant/40 rounded-2xl sm:max-w-md max-h-[72dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {panel === "contents"
                  ? "目录"
                  : panel === "more"
                    ? "更多"
                    : panel === "search"
                      ? "搜索正文"
                      : panel === "encoding"
                        ? "编码格式"
                        : panel === "directory"
                          ? "目录规则"
                          : "自动翻页"}
              </DialogTitle>
              <DialogDescription>
                {panel === "contents"
                  ? "按正文位置跳转"
                  : panel === "more"
                    ? "书签与阅读进度"
                    : panel === "search"
                      ? "在当前 TXT 中查找文字"
                      : panel === "encoding"
                        ? "只在当前 TXT 内重新解码，不会上传正文"
                        : panel === "directory"
                          ? "预览识别结果，再应用到本书目录"
                          : "仅在阅读本书期间自动翻页"}
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
            {panel === "encoding" && (
              <div className="space-y-3">
                <label htmlFor="reader-encoding" className="block text-sm">
                  文本编码
                </label>
                <select
                  id="reader-encoding"
                  autoFocus
                  className="w-full rounded-lg border border-surface-variant bg-surface-container px-3 py-2"
                  value={encodingInfo?.selected ?? "auto"}
                  disabled={
                    !encodingInfo?.canChange ||
                    libraryState.decoding ||
                    ruleOperation.current === "save"
                  }
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
            )}
            {panel === "directory" && (
              <div className="space-y-3">
                <label className="block space-y-1 text-sm">
                  <span>章节识别规则</span>
                  <select
                    autoFocus
                    disabled={ruleBusy || toolsLoading || Boolean(toolsError)}
                    className="w-full rounded-lg border border-surface-variant bg-surface-container px-3 py-2"
                    value={ruleDraft.mode}
                    onChange={(event) => {
                      setRuleDraft((current) => ({
                        ...current,
                        mode: event.target.value as TxtTocRule["mode"],
                      }));
                      ruleRequest.current += 1;
                      setRuleBusy(false);
                      setRulePreview(null);
                      setRuleError(null);
                    }}
                  >
                    <option value="automatic">自动识别中英文</option>
                    <option value="chinese">中文章节</option>
                    <option value="english">英文 Chapter</option>
                    <option value="custom">自定义正则</option>
                  </select>
                </label>
                {ruleDraft.mode === "custom" && (
                  <label className="block space-y-1 text-sm">
                    <span>每行匹配一个章节标题</span>
                    <input
                      className="w-full rounded-lg border border-surface-variant bg-surface-container px-3 py-2 font-mono text-xs"
                      disabled={ruleBusy || toolsLoading || Boolean(toolsError)}
                      value={ruleDraft.pattern}
                      placeholder="^第.+章.*$"
                      onChange={(event) => {
                        setRuleDraft((current) => ({ ...current, pattern: event.target.value }));
                        ruleRequest.current += 1;
                        setRuleBusy(false);
                        setRulePreview(null);
                        setRuleError(null);
                      }}
                    />
                  </label>
                )}
                {ruleError && (
                  <p role="alert" className="text-sm text-error">
                    {ruleError}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void previewDirectory()}
                    disabled={ruleBusy || toolsLoading || Boolean(toolsError)}
                  >
                    {ruleBusy && ruleOperation.current === "preview" ? "正在预览…" : "预览"}
                  </Button>
                  <Button
                    onClick={applyDirectory}
                    disabled={
                      ruleBusy || toolsLoading || Boolean(toolsError) || rulePreview === null
                    }
                  >
                    {ruleBusy && ruleOperation.current === "save" ? "正在应用…" : "应用本书"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={
                      ruleBusy ||
                      toolsLoading ||
                      Boolean(toolsError) ||
                      (tocRule.mode === "automatic" && ruleDraft.mode === "automatic")
                    }
                    onClick={() => {
                      const defaultRule: TxtTocRule = { mode: "automatic", pattern: "" };
                      setRuleDraft(defaultRule);
                      setRulePreview(null);
                      void persistDirectory(defaultRule);
                    }}
                  >
                    恢复默认
                  </Button>
                </div>
                {rulePreview !== null && (
                  <div className="space-y-2">
                    <p role="status" className="text-xs text-secondary">
                      预览到 {rulePreview.length} 个章节；确认应用后才会替换本书目录。
                    </p>
                    <div className="max-h-64 overflow-auto rounded-lg border border-surface-variant/40 p-2">
                      {rulePreview.length === 0 ? (
                        <p className="p-2 text-sm text-secondary">
                          没有匹配章节，可从全文开始阅读。
                        </p>
                      ) : (
                        rulePreview.map((entry) => (
                          <div
                            key={`${entry.ordinal}-${entry.locator.offset}`}
                            className="flex justify-between gap-3 p-2 text-xs"
                          >
                            <span className="truncate">{entry.title}</span>
                            <span className="shrink-0 text-secondary">
                              {totalLength
                                ? `${Math.floor((entry.locator.offset / totalLength) * 100)}%`
                                : `第 ${entry.ordinal + 1} 章`}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            {panel === "automatic" && (
              <div className="space-y-4">
                <label className="block space-y-2 text-sm">
                  <span className="flex justify-between">
                    <span>每页间隔</span>
                    <output>{preferences?.autoPageSeconds ?? 8} 秒</output>
                  </span>
                  <input
                    aria-label="自动翻页间隔"
                    type="range"
                    min={2}
                    max={60}
                    step={1}
                    disabled={!preferences}
                    value={preferences?.autoPageSeconds ?? 8}
                    onChange={(event) =>
                      settingsStore.set({ autoPageSeconds: Number(event.target.value) })
                    }
                    className="w-full accent-primary"
                  />
                </label>
                {automaticTurn.running ? (
                  <Button variant="outline" onClick={automaticTurn.pause}>
                    暂停自动翻页
                  </Button>
                ) : (
                  <Button
                    disabled={
                      !controller ||
                      !state.hasAfter ||
                      state.loading ||
                      Boolean(state.error || state.saveError) ||
                      closing ||
                      libraryState.decoding
                    }
                    onClick={() => {
                      setPanel(null);
                      setControls(false);
                      automaticTurn.start();
                    }}
                  >
                    开始自动翻页
                  </Button>
                )}
                <p className="text-xs text-secondary">
                  手动翻页、显示工具栏、打开面板或切换到后台时会暂停。
                </p>
              </div>
            )}
            {panel === "contents" && (
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
                        closePanel();
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
                            closePanel();
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
            {panel === "more" && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Button variant="outline" disabled={!page || closing} onClick={addBookmark}>
                    添加当前位置书签
                  </Button>
                  <Button
                    data-testid="reader-save"
                    variant="outline"
                    disabled={!controller || closing}
                    onClick={() => {
                      closePanel();
                      if (controller) run(() => controller.flush());
                    }}
                  >
                    保存进度
                  </Button>
                </div>
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
                          closePanel();
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
                            await runtime.services.reader.deleteBookmark({
                              bookmarkId: bookmark.id,
                            });
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
              </div>
            )}
            {panel === "search" && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    autoFocus
                    aria-label="搜索关键词"
                    className="flex-1 rounded-lg border border-surface-variant bg-surface-container px-3 py-2"
                    value={searchQuery}
                    onChange={(event) => {
                      cancelSearch();
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
                        closePanel();
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

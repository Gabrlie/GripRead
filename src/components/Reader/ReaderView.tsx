import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useLayoutEffect,
  useCallback,
  useSyncExternalStore,
} from "react";
import { useReducedMotion } from "motion/react";
import { useApp } from "../../context/AppContext";
import { useImage, useLibrary, useRuntime, useSettings } from "../../application/runtime";
import {
  ReaderController,
  DomReaderMeasurer,
  HeadingIndex,
  PageTurnAdapter,
  bookImages,
  emptyReaderSnapshot,
  setReaderImages,
  withoutMarks,
} from "../../reader";
import type { ReaderSnapshot } from "../../reader";
import type {
  Bookmark,
  ProgressPrompt,
  ReaderTool,
  ReplaceRule,
  TxtEncoding,
  TxtEncodingInfo,
} from "../../types/generated";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { useAutomaticTurn } from "./use-automatic-turn";
import { useReadingTime } from "./use-reading-time";
import { SelectionMenu, type SelectionActions } from "./SelectionMenu";
import { EMPTY_REPLACE_RULE, ReplaceRuleEditor, ReplaceRulesPage } from "../Rules/ReplaceRulesPage";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { ReadAloudDialog } from "./dialogs/ReadAloudDialog";
import {
  ReadAloud,
  windowParagraphs,
  type ReadAloudRange,
  type ReadAloudSnapshot,
} from "../../reader/read-aloud";
import { clearSpeech, paintSpeech, speechHighlightSupported } from "./speech-highlight";
import { speechEngine } from "../../services/speech";

const NO_SUBSCRIBE = () => () => undefined;
const IDLE_SNAPSHOT: ReadAloudSnapshot = {
  state: "idle",
  current: null,
  stopsAt: null,
  failed: false,
};
const IDLE_ALOUD = () => IDLE_SNAPSHOT;
const loadVoices = () => speechEngine().voices();
const speechStatus = () => speechEngine().status();
import { BookmarkNoteDialog } from "./dialogs/BookmarkNoteDialog";
import { useReaderActions } from "./use-reader-actions";
import { canShowSpread, useReaderLayout, syncMeasureBox } from "./use-reader-layout";
import { useReaderPanel, type ReaderPanel } from "./use-reader-panel";
import { useReaderSearch } from "./use-reader-search";
import { useReaderTools } from "./use-reader-tools";
import { ReaderPageText } from "./ReaderPageText";
import { ReaderScrollText } from "./ReaderScrollText";
import { ReaderSurface, interactiveTarget, selectionActive } from "./ReaderSurface";
import type { GestureHandlers, TapZones } from "../../reader/gestures";
import { currentPreset, readingAppearance, useNight } from "./reading-style";
import { ReaderInfoBar } from "./ReaderInfoBar";
import { copyText, system } from "../../services/system";
import { ReaderBottomBar, ReaderBrightnessBar, ReaderTopBar } from "./ReaderToolbar";
import { StylePanel } from "./panels/StylePanel";
import { ContentsPage } from "./pages/ContentsPage";
import { SearchPage, SearchResultBar } from "./pages/SearchPage";
import { TocRuleDialog } from "./dialogs/TocRuleDialog";
import { EncodingDialog } from "./dialogs/EncodingDialog";
import { AutoPagePanel } from "./dialogs/AutoPagePanel";
import { BottomToolsDialog } from "./dialogs/BottomToolsDialog";
import { t } from "../../i18n";
import { ConversionDialog } from "./dialogs/ConversionDialog";
import { TranslationDialog } from "./dialogs/TranslationDialog";
import { TranslationSettingsPage } from "../Settings/TranslationSettingsPage";
import { CloudProgressDialog } from "./dialogs/CloudProgressDialog";
import { BookDetailPage } from "../Bookshelf/BookDetailPage";
import { keepOnlineCover, updateOnlineToc } from "../../application/online";
import { rememberChaptersWhenRead } from "../../application/shelf";
import { appLog } from "../../services/log";
import { CacheRangeDialog } from "../Online/CacheRangeDialog";
import { ChangeSourceDialog } from "../Online/ChangeSourceDialog";
import type { ContentWindow } from "../../types/generated";

const empty: ReaderSnapshot = { ...emptyReaderSnapshot(), loading: true };

/**
 * Whole-book progress in percent: within the text for a local book, and
 * by chapter for a book read chapter by chapter.
 */
function bookProgressOf(
  window: ContentWindow | null,
  page: { endOffset: number; totalLength: number } | null,
): number {
  if (!page || !page.totalLength) return 0;
  const within = page.endOffset / page.totalLength;
  const count = window?.resourceCount;
  if (count && window.resourceIndex !== undefined)
    return ((window.resourceIndex + within) / count) * 100;
  return within * 100;
}
const noopSubscribe = () => () => {};

function safeExcerpt(source: string, maxUnits = 160): string {
  // EPUB image and directory marks are not part of what was read.
  const text = withoutMarks(source);
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
  const { activeBook, closeReader, takeReaderPage } = useApp();
  const runtime = useRuntime();
  const { state: libraryState } = useLibrary();
  const { state: settings, store: settingsStore } = useSettings();
  const reducedMotion = useReducedMotion();
  const pageBox = useRef<HTMLDivElement>(null);
  const measureBox = useRef<HTMLDivElement>(null);
  const gestureBox = useRef<HTMLDivElement>(null);
  const animationBox = useRef<HTMLDivElement>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  const synchronizeScroll = useRef<(() => void) | null>(null);
  const adapter = useRef<PageTurnAdapter | null>(null);
  const measurer = useRef<DomReaderMeasurer | null>(null);
  const [controller, setController] = useState<ReaderController | null>(null);
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? (() => empty),
  );
  const [controls, setControls] = useState(false);
  /** The margin dialog previews on an unobstructed page, so the menu hides. */
  const [previewing, setPreviewing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const preferences = settings.value;
  const bookId = activeBook?.book.id;
  const effectiveMode =
    preferences?.readingMode === "double" && !canShowSpread(viewport.width, viewport.height)
      ? "single"
      : (preferences?.readingMode ?? "single");
  useEffect(() => {
    // Android WebViews can report the old size in the resize event of a
    // rotation, so the root element's observed size decides as well.
    const root = document.documentElement;
    const resize = () =>
      setViewport((current) => {
        const width = root.clientWidth || window.innerWidth;
        const height = root.clientHeight || window.innerHeight;
        return current.width === width && current.height === height ? current : { width, height };
      });
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
    };
  }, []);
  /** The search result being read, while the result bar is shown. */
  const [searchIndex, setSearchIndex] = useState<number | null>(null);
  useEffect(() => setSearchIndex(null), [bookId]);
  const actions = useReaderActions(bookId);
  const { run, fail, sessionEpoch, failedAction, actionError } = actions;
  const search = useReaderSearch(bookId, runtime.services.reader, run);
  const panelRef = useRef<ReaderPanel | null>(null);
  const tools = useReaderTools(activeBook, runtime, actions);
  const { flushDirectory } = tools;
  // Chapter headings mark the same lines for measuring and every renderer.
  const headings = useMemo(
    () => new HeadingIndex(tools.toc.map((entry) => entry.locator.offset)),
    [tools.toc],
  );
  const headingsRef = useRef(headings);
  headingsRef.current = headings;
  useLayoutEffect(() => {
    measurer.current?.setHeadings(headings);
    adapter.current?.setHeadings(headings);
  }, [headings]);
  const night = useNight(preferences);
  const style = preferences?.style;
  const fontAssetId = style?.fontAssetId ?? null;
  const [customFont, setCustomFont] = useState<{ id: string; family: string } | null>(null);
  const [fontError, setFontError] = useState<string | null>(null);
  useEffect(() => {
    if (!fontAssetId) {
      setFontError(null);
      return;
    }
    let cancelled = false;
    runtime.fonts.load(fontAssetId).then(
      (family) => {
        if (cancelled) return;
        setCustomFont({ id: fontAssetId, family });
        setFontError(null);
      },
      (error: unknown) => {
        if (!cancelled) setFontError(t("reader.fontFailed", { error: String(error) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fontAssetId, runtime.fonts]);
  // A style's background image for the current day or night variant; turns
  // draw the loaded image into their page copies.
  const preset = style ? currentPreset(style) : null;
  const backgroundUrl = useImage(
    (night ? preset?.nightBackgroundImage : preset?.backgroundImage) ?? null,
  );
  const backgroundImage = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    backgroundImage.current = null;
    if (!backgroundUrl) return;
    const image = new Image();
    image.onload = () => (backgroundImage.current = image);
    image.src = backgroundUrl;
  }, [backgroundUrl]);
  const appearance = readingAppearance(
    preferences,
    night,
    customFont && customFont.id === fontAssetId ? customFont.family : null,
    backgroundUrl ?? null,
  );
  // Legado keeps the screen on and can hide the system bars while reading.
  const keepScreenOn = style?.keepScreenOn ?? true;
  const hideBars = style?.hideSystemBars ?? false;
  const volumeKeys = style?.volumeKeys ?? true;
  useEffect(() => {
    if (!bookId || !keepScreenOn) return;
    system.setKeepScreenOn(true);
    return () => system.setKeepScreenOn(false);
  }, [bookId, keepScreenOn]);
  // Brightness set from the reading menu lasts for this reading session only;
  // it and the screen orientation return to the system on leaving.
  const [brightness, setBrightness] = useState<number | null>(null);
  useEffect(() => setBrightness(null), [bookId]);
  const orientation = style?.orientation ?? "auto";
  useEffect(() => {
    if (!bookId) return;
    system.setBrightness(brightness);
  }, [bookId, brightness]);
  useEffect(() => {
    if (!bookId) return;
    return () => system.setBrightness(null);
  }, [bookId]);
  useEffect(() => {
    if (!bookId || orientation === "auto") return;
    system.setOrientation(orientation);
    return () => system.setOrientation("auto");
  }, [bookId, orientation]);
  const { cancel: cancelSearch } = search;
  // Contents opened from the shelf's detail page go back there when left
  // without choosing a place, like Legado's separate 目录 page.
  const fromDetail = useRef(false);
  const leaveToDetail = useRef<() => void>(() => undefined);
  const onPanelClose = useCallback(
    (closed: ReaderPanel) => {
      if (closed === "contents" && fromDetail.current) {
        fromDetail.current = false;
        queueMicrotask(() => leaveToDetail.current());
      }
      // Results stay for the result bar; only a running search stops.
      if (closed === "search") cancelSearch();
      // Previewed adjustments are written at once when their panel closes.
      if (closed === "style" || closed === "settings")
        void settingsStore.flush().catch(() => undefined);
    },
    [cancelSearch, settingsStore],
  );
  const panels = useReaderPanel(onPanelClose);
  const { panel, open: openPanelState, close: closePanel } = panels;
  panelRef.current = panel;

  const automaticTurn = useAutomaticTurn({
    intervalSeconds: preferences?.autoPageSeconds ?? 8,
    scroll:
      effectiveMode === "scroll"
        ? {
            speed: preferences?.autoScrollSpeed ?? 40,
            advance: (pixels: number) => {
              const box = scrollBox.current;
              if (!box) return;
              const before = box.scrollTop;
              box.scrollTop += pixels;
              // At a chapter's end, automatic scrolling opens the next one.
              const window = controller?.getSnapshot().scroll;
              if (
                box.scrollTop === before &&
                pixels > 0 &&
                window &&
                !window.hasAfter &&
                window.nextResourceId &&
                controller
              )
                run(() => controller.seekChapter("next"));
            },
          }
        : undefined,
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
  const pauseAutomatic = automaticTurn.pause;
  /**
   * From starting automatic turning until leaving it, a tap on the menu zone
   * shows the automatic panel instead of the reading menu (Legado
   * AutoReadDialog). While turning runs, the panel hides after a while.
   */
  const [autoSession, setAutoSession] = useState(false);
  // Read by handlers defined before the session state is current.
  const autoSessionLive = useRef(autoSession);
  autoSessionLive.current = autoSession;
  const [autoPanel, setAutoPanel] = useState(false);
  const [autoActivity, setAutoActivity] = useState(0);
  useEffect(() => {
    setAutoSession(false);
    setAutoPanel(false);
  }, [bookId]);
  useEffect(() => {
    if (!autoPanel || !automaticTurn.running) return;
    const timer = window.setTimeout(() => setAutoPanel(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [autoPanel, automaticTurn.running, autoActivity]);
  const openPanel = useCallback(
    (next: ReaderPanel) => {
      void pauseAutomatic();
      setControls(true);
      openPanelState(next);
    },
    [openPanelState, pauseAutomatic],
  );
  // Legado's 朗读: paragraphs from the visible page, following the reading.
  const columnsRef = useRef(1);
  columnsRef.current = effectiveMode === "double" ? 2 : 1;
  const speechOptions = {
    rate: style?.speechRate ?? 1,
    pitch: style?.speechPitch ?? 1,
    voice: style?.speechVoice ?? null,
  };
  const speechOptionsRef = useRef(speechOptions);
  speechOptionsRef.current = speechOptions;
  const readAloud = useMemo(() => {
    if (!controller) return null;
    const text = () => {
      const snapshot = controller.getSnapshot();
      return snapshot.mode === "scroll" ? snapshot.scroll : snapshot.contentWindow;
    };
    return new ReadAloud(
      speechEngine(),
      {
        paragraphs: (offset, limit) => {
          const window = text();
          return window ? windowParagraphs(window.text, window.startOffset, offset, limit) : [];
        },
        pageStart: () => {
          const snapshot = controller.getSnapshot();
          return snapshot.page?.startOffset ?? snapshot.scroll?.startOffset ?? 0;
        },
        pageEnd: () => {
          const snapshot = controller.getSnapshot();
          // Scroll mode reads the loaded text without turning.
          if (snapshot.mode === "scroll") return Number.POSITIVE_INFINITY;
          const visible = snapshot.pages.slice(
            snapshot.pageIndex,
            snapshot.pageIndex + columnsRef.current,
          );
          return visible.at(-1)?.endOffset ?? snapshot.page?.endOffset ?? 0;
        },
        next: async () => {
          const snapshot = controller.getSnapshot();
          if (snapshot.mode === "scroll") {
            // Scrolling reads on into text loaded after the current window.
            if (!snapshot.scroll?.hasAfter) {
              // A book read chapter by chapter goes on with the next one.
              if (!snapshot.scroll?.nextResourceId) return false;
              await controller.seekChapter("next");
              return true;
            }
            await controller.extendScroll("forward");
            return true;
          }
          if (!snapshot.hasAfter) return false;
          adapter.current?.skipNextAnimation();
          await controller.next();
          return true;
        },
        highlight: (paragraph, spoken) => {
          speechMark.current = paragraph ? { paragraph, spoken } : null;
          if (speechHighlightSupported()) paintSpeechRef.current();
          else search.setHighlight(paragraph);
        },
      },
      speechOptionsRef.current,
    );
    // The search highlight setter is stable for the session.
  }, [controller]);
  useEffect(() => () => readAloud?.dispose(), [readAloud]);
  /** What read-aloud marks; painted again whenever the text re-renders. */
  const speechMark = useRef<{ paragraph: ReadAloudRange; spoken: ReadAloudRange | null } | null>(
    null,
  );
  const paintSpeechRef = useRef(() => {});
  paintSpeechRef.current = () => {
    const root = gestureBox.current;
    if (!root || !speechHighlightSupported()) return;
    const mark = speechMark.current;
    if (!mark) {
      clearSpeech();
      return;
    }
    const focus = paintSpeech(root, mark.paragraph, mark.spoken);
    // Scrolling follows the reading, keeping it in the upper part of the screen.
    const box = scrollBox.current;
    if (focus && box && effectiveMode === "scroll") {
      const view = box.getBoundingClientRect();
      if (focus.bottom > view.bottom - view.height * 0.2 || focus.top < view.top)
        box.scrollTo({
          top: box.scrollTop + focus.top - view.top - view.height * 0.3,
          behavior: reducedMotion ? "auto" : "smooth",
        });
    }
  };
  useLayoutEffect(() => {
    paintSpeechRef.current();
  }, [state.page, state.pages, state.scroll, state.scrollRevision, effectiveMode]);
  useEffect(() => () => clearSpeech(), [bookId]);
  useEffect(() => {
    readAloud?.setOptions(speechOptions);
  }, [readAloud, speechOptions.rate, speechOptions.pitch, speechOptions.voice]);
  const aloud = useSyncExternalStore(
    readAloud?.subscribe ?? NO_SUBSCRIBE,
    readAloud?.getSnapshot ?? IDLE_ALOUD,
  );
  useReadingTime(
    bookId,
    runtime.services.library,
    automaticTurn.running || aloud.state === "playing",
  );
  /**
   * Legado's 同步阅读进度: opening a book asks about another device's newer
   * position; leaving uploads this one. 同步增强 also does both when the
   * reader returns from the background or the network comes back.
   */
  const progressSyncOn = useRef(false);
  const progressSyncPlus = useRef(false);
  const [cloudProgress, setCloudProgress] = useState<ProgressPrompt | null>(null);
  const checkCloudProgress = useCallback(() => {
    if (!bookId || !progressSyncOn.current) return;
    void runtime.progressSync.fetch(bookId).then(
      (prompt) => prompt && setCloudProgress((shown) => shown ?? prompt),
      () => undefined,
    );
  }, [bookId, runtime.progressSync]);
  useEffect(() => {
    setCloudProgress(null);
    if (!bookId) return;
    let cancelled = false;
    const sync = runtime.services.sync;
    // With the GripRead server, progress always syncs and is offered here.
    void Promise.all([sync.getWebDav(), sync.getServer().catch(() => null)]).then(
      ([settings, server]) => {
        if (cancelled) return;
        const connected = server?.connected ?? false;
        progressSyncOn.current = connected || (settings.configured && settings.syncProgress);
        progressSyncPlus.current =
          connected || (progressSyncOn.current && settings.syncProgressPlus);
        checkCloudProgress();
      },
      () => undefined,
    );
    void sync.setSyncOpenBook(bookId).catch(() => undefined);
    let stop: (() => void) | undefined;
    void sync
      .onSyncProgress((arrived) => {
        if (arrived === bookId) checkCloudProgress();
      })
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else stop = unsubscribe;
      });
    return () => {
      cancelled = true;
      stop?.();
      void sync.setSyncOpenBook(null).catch(() => undefined);
    };
  }, [bookId, checkCloudProgress, runtime.services.sync]);
  useEffect(() => {
    if (!bookId) return;
    const visibility = () => {
      if (!progressSyncPlus.current) return;
      if (document.visibilityState === "visible") checkCloudProgress();
      else {
        const chapterTitle = controller?.getSnapshot().chapter?.title ?? "";
        void runtime.positions
          .flush()
          .then(() => runtime.progressSync.upload(bookId, chapterTitle))
          .catch(() => undefined);
      }
    };
    const online = () => progressSyncPlus.current && checkCloudProgress();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
    };
  }, [bookId, checkCloudProgress, controller, runtime]);

  // The book detail page can open the reader on its contents.
  useEffect(() => {
    if (takeReaderPage() !== "contents") return;
    fromDetail.current = true;
    openPanel("contents");
  }, [openPanel, takeReaderPage]);
  /**
   * Manual reading stops the automatic countdown; during a running automatic
   * session the returned function starts it again afterwards (Legado), so a
   * manual turn never leaves turning paused by surprise.
   */
  const automaticRunning = useRef(false);
  automaticRunning.current = automaticTurn.running;
  const autoSessionRef = autoSessionLive;
  const startAutomatic = automaticTurn.start;
  const interruptAutomatic = useCallback(() => {
    const resume = autoSessionRef.current && automaticRunning.current;
    void pauseAutomatic();
    return resume ? startAutomatic : () => undefined;
  }, [pauseAutomatic, startAutomatic]);
  const turn = useCallback(
    (direction: "next" | "previous", point?: { x: number; y: number }) => {
      const resume = interruptAutomatic();
      adapter.current?.aim(point ?? null);
      if (effectiveMode === "scroll") {
        if (scrollBox.current)
          scrollBox.current.scrollTop +=
            scrollBox.current.clientHeight * (direction === "next" ? 0.9 : -0.9);
        resume();
        return;
      }
      if (controller)
        run(async () => {
          await (direction === "next" ? controller.next() : controller.previous());
          resume();
        });
    },
    [controller, effectiveMode, interruptAutomatic, run],
  );

  // A book read from search is only kept if the reader adds it (Legado
  // asks the same when leaving a book that is not on the shelf).
  const shelfChoice = useRef<"add" | "leave" | null>(null);
  const [cachingRange, setCachingRange] = useState(false);
  const [changingSource, setChangingSource] = useState(false);
  const [askShelf, setAskShelf] = useState<{ toDetail: boolean } | null>(null);
  const close = useCallback(
    (toDetail = false) => {
      if (closing) return;
      if (activeBook?.online && !activeBook.online.onShelf && shelfChoice.current === null) {
        setAskShelf({ toDetail });
        return;
      }
      setClosing(true);
      // The shelf marks chapters added after this read in red.
      if (bookId && tools.toc.length)
        rememberChaptersWhenRead(bookId, tools.toc.filter((entry) => !entry.volume).length);
      synchronizeScroll.current?.();
      void pauseAutomatic();
      controller?.dispose();
      runtime.finishReaderWrite(flushDirectory);
      runtime.finishReaderWrite(settingsStore.flush);
      closeReader(toDetail);
      const leaving = bookId;
      const chapterTitle = controller?.getSnapshot().chapter?.title ?? "";
      void runtime.positions
        .flush()
        .then(() => {
          // Legado 同步阅读进度: leaving the reader uploads the position.
          if (leaving && progressSyncOn.current)
            void runtime.progressSync.upload(leaving, chapterTitle).catch(() => undefined);
          // A book left off the shelf keeps its place for 30 days, so opening
          // it again from search resumes reading.
          return runtime.library.refresh();
        })
        .catch(() => undefined);
    },
    [
      activeBook,
      bookId,
      controller,
      closing,
      closeReader,
      fail,
      flushDirectory,
      pauseAutomatic,
      runtime,
      settingsStore,
      tools.toc,
    ],
  );
  leaveToDetail.current = () => close(true);
  // Errors the reader shows also go to the app log.
  useEffect(() => {
    if (state.error)
      appLog.write("error", "reader", `《${activeBook?.book.title ?? ""}》${state.error}`);
  }, [state.error]);

  const { setBookmarks, setEncodingInfo, reload: reloadTools } = tools;
  const addBookmark = useCallback(() => {
    const page = state.page;
    if (!bookId || !page || !state.contentWindow) return;
    const epoch = sessionEpoch.current;
    run(async () => {
      const created = await runtime.services.reader.addBookmark({
        bookId,
        locator: page.locator,
        excerpt: safeExcerpt(page.text),
      });
      if (epoch !== sessionEpoch.current) return;
      setBookmarks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      toast(t("reader.bookmarkAdded"));
    });
  }, [
    bookId,
    run,
    runtime.services.reader,
    sessionEpoch,
    setBookmarks,
    state.contentWindow,
    state.page,
  ]);

  const useTool = (tool: ReaderTool) => {
    const panels: Partial<Record<ReaderTool, ReaderPanel>> = {
      search: "search",
      "read-aloud": "aloud",
      contents: "contents",
      style: "style",
      "replace-rules": "replace",
      "toc-rules": "rules",
      encoding: "encoding",
      "more-settings": "settings",
    };
    const target = panels[tool];
    if (target) openPanel(target);
    else if (tool === "night") settingsStore.set({ theme: night ? "light" : "dark" });
    else if (tool === "bookmark") addBookmark();
    else if (tool === "auto-page") startAutomaticSession();
  };
  /**
   * 自动翻页 starts at once with the interval and page animation already
   * chosen; its floating panel adjusts or stops it.
   */
  const startAutomaticSession = () => {
    setControls(false);
    setAutoPanel(true);
    if (autoSession && automaticTurn.running) return;
    if (!canStartAutomatic) {
      toast(state.hasAfter ? t("reader.autoNotYet") : t("reader.end"));
      return;
    }
    setAutoSession(true);
    automaticTurn.start();
  };

  /**
   * Leaving scroll mode records the passage at the top of the scroll view
   * now, while its text is still laid out; afterwards the page layout has
   * replaced it.
   */
  const changePreferences = (patch: Parameters<typeof settingsStore.set>[0]) => {
    if (
      effectiveMode === "scroll" &&
      patch.readingMode !== undefined &&
      patch.readingMode !== "scroll"
    )
      synchronizeScroll.current?.();
    settingsStore.set(patch);
  };

  /** A bookmark being added from selected text, or a bookmark whose note is edited. */
  const [noteDraft, setNoteDraft] = useState<
    { excerpt: string; offset: number } | { excerpt: string; bookmark: Bookmark } | null
  >(null);
  const answerCloudProgress = (jump: boolean) => {
    const prompt = cloudProgress;
    setCloudProgress(null);
    if (!prompt || !bookId) return;
    void runtime.progressSync.acknowledge(prompt, bookId).catch(() => undefined);
    if (jump && controller) {
      void pauseAutomatic();
      run(async () => {
        await controller.seek(prompt.locator);
        toast(t("reader.progressSynced", { device: prompt.deviceName || t("reader.otherDevice") }));
      });
    }
  };
  /** Dialogs opened from the top bar's 更多 menu, and the book detail page. */
  const [dialog, setDialog] = useState<
    "conversion" | "tools" | "detail" | "translation" | "translationSettings" | null
  >(null);
  // 更新目录 reports its outcome once the directory has been read again.
  const refreshingDirectory = useRef(false);
  useEffect(() => {
    if (!refreshingDirectory.current || tools.loading) return;
    refreshingDirectory.current = false;
    toast(
      tools.error
        ? t("detail.updateFailed", { error: tools.error })
        : t("reader.tocUpdated", { count: tools.toc.length }),
    );
  }, [tools.loading, tools.error, tools.toc]);
  const saveNote = useCallback(
    async (note: string) => {
      const draft = noteDraft;
      const window = state.contentWindow;
      if (!draft || !bookId) return;
      if ("bookmark" in draft) {
        await runtime.services.reader.updateBookmarkNote(draft.bookmark.id, note);
        setBookmarks((current) =>
          current.map((item) => (item.id === draft.bookmark.id ? { ...item, note } : item)),
        );
        return;
      }
      if (!window) return;
      const locator = await runtime.services.reader.resolveOffset({
        bookId,
        contentVersion: window.contentVersion,
        resourceId: window.resourceId,
        offset: draft.offset,
      });
      const created = await runtime.services.reader.addBookmark({
        bookId,
        locator,
        excerpt: safeExcerpt(draft.excerpt),
        note,
      });
      setBookmarks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      toast(t("reader.bookmarkAdded"));
    },
    [bookId, noteDraft, runtime.services.reader, setBookmarks, state.contentWindow],
  );
  const selectionActions = useMemo<SelectionActions>(
    () => ({
      copy: (selection) =>
        void copyText(selection.text).then(
          () => toast(t("reader.copied")),
          () => toast(t("reader.copyFailed")),
        ),
      bookmark: (selection) => setNoteDraft({ excerpt: selection.text, offset: selection.start }),
      search: (selection) => {
        openPanel("search");
        search.searchFor(selection.text);
      },
      share: (selection) =>
        void system.share(selection.text).then(
          (result) => result === "copied" && toast(t("reader.copiedShare")),
          () => undefined,
        ),
      // Legado's 替换: a plain-text rule for the selection, scoped to this book.
      replace: (selection) =>
        setReplaceDraft({
          ...EMPTY_REPLACE_RULE,
          name: selection.text.slice(0, 20),
          pattern: selection.text,
          isRegex: false,
          scope: activeBook?.book.title ?? "",
        }),
    }),
    [activeBook?.book.title, openPanel, search],
  );
  const [replaceDraft, setReplaceDraft] = useState<ReplaceRule | null>(null);
  // The reader's selection menu replaces the WebView's own toolbar.
  useEffect(() => {
    if (!bookId) return;
    system.setSelectionMenu(true);
    return () => system.setSelectionMenu(false);
  }, [bookId]);

  const { clearResults } = search;
  /**
   * Re-derives the book's text (a new encoding, or changed replace rules and
   * Chinese conversion) and reopens it at the relocated position.
   */
  const redecode = useCallback(
    (decode: (bookId: string) => Promise<TxtEncodingInfo | null>, quiet = false) => {
      if (!bookId || !controller || tools.savingSettings()) return;
      const epoch = sessionEpoch.current;
      run(async () => {
        if (!quiet) {
          void pauseAutomatic();
          setSearchIndex(null);
          clearResults();
        }
        await controller.flush();
        const next = await decode(bookId);
        if (!next || epoch !== sessionEpoch.current) return;
        void pauseAutomatic();
        setSearchIndex(null);
        clearResults();
        setEncodingInfo(next);
        runtime.positions.forget(bookId);
        await controller.open(bookId);
        if (epoch !== sessionEpoch.current) return;
        reloadTools();
        await runtime.library.refresh();
      });
    },
    [
      bookId,
      clearResults,
      controller,
      pauseAutomatic,
      reloadTools,
      run,
      runtime,
      sessionEpoch,
      setEncodingInfo,
      tools,
    ],
  );
  const changeEncoding = useCallback(
    (encoding: TxtEncoding) => redecode((id) => runtime.library.decodeTxt(id, encoding)),
    [redecode, runtime.library],
  );
  /** Reads the book again in place, as after its translation changed. */
  const reopen = useCallback(() => {
    if (!bookId || !controller) return;
    const epoch = sessionEpoch.current;
    run(async () => {
      await controller.flush();
      if (epoch !== sessionEpoch.current) return;
      runtime.positions.forget(bookId);
      await controller.open(bookId);
    });
  }, [bookId, controller, run, runtime, sessionEpoch]);
  /** Applies replace rules and Chinese conversion when they changed. */
  const applyTransforms = useCallback(
    () =>
      redecode(async (id) => {
        // The conversion setting is read from saved preferences.
        await runtime.settings.flush();
        if (runtime.library.getSnapshot().decoding) return null;
        return runtime.library.applyTextTransforms(id);
      }, true),
    [redecode, runtime],
  );
  const applyTransformsRef = useRef(applyTransforms);
  applyTransformsRef.current = applyTransforms;
  // A translated local book: each new snapshot of its translations is
  // applied like a changed rule, and the job resumes when the book opens.
  const localBook = Boolean(bookId) && !activeBook?.online;
  const [translating, setTranslating] = useState<number | null>(null);
  useEffect(() => {
    if (!bookId || !localBook) return;
    const service = runtime.services.translation;
    let unlisten: (() => void) | undefined;
    let active = true;
    setTranslating(null);
    void service
      .onBookProgress((event) => {
        if (event.bookId !== bookId) return;
        setTranslating(
          event.finished || !event.total ? null : Math.floor((event.done * 100) / event.total),
        );
        if (event.applied) applyTransformsRef.current();
      })
      .then((stop) => (active ? (unlisten = stop) : stop()));
    void service.getBook(bookId).then(
      (book) => active && book.translateTo && void service.translateBook(bookId, false),
      () => undefined,
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, [bookId, localBook, runtime]);
  // A book opened after rules or the conversion changed gets them applied.
  const transformsChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!bookId || !controller || transformsChecked.current === bookId) return;
    transformsChecked.current = bookId;
    applyTransformsRef.current();
  }, [bookId, controller]);
  const chineseConversion = style?.chineseConversion ?? "off";
  const appliedConversion = useRef(chineseConversion);
  useEffect(() => {
    if (appliedConversion.current === chineseConversion) return;
    appliedConversion.current = chineseConversion;
    applyTransformsRef.current();
  }, [chineseConversion]);
  const useReplaceRules =
    libraryState.books.find((book) => book.book.id === bookId)?.useReplaceRules ??
    activeBook?.useReplaceRules ??
    true;
  const replaceChanged = useRef(false);
  const toggleBookReplace = useCallback(
    (enabled: boolean) => {
      if (!bookId) return;
      run(async () => {
        await runtime.services.library.setBookReplaceRules(bookId, enabled);
        await runtime.library.refresh();
        applyTransformsRef.current();
      });
    },
    [bookId, run, runtime],
  );

  // An EPUB's image sizes are needed before its pages are measured.
  const imagesReady = useRef<Promise<void>>(Promise.resolve());
  useLayoutEffect(() => {
    if (!bookId) return;
    let images: ReturnType<typeof bookImages> | null = null;
    let active = true;
    imagesReady.current = runtime.services.library.listBookImages(bookId).then(
      (sizes) => {
        if (!active || !sizes.length) return;
        images = bookImages(sizes, (index) =>
          runtime.services.library.readBookImage(bookId, index),
        );
        setReaderImages(images);
      },
      () => undefined,
    );
    return () => {
      active = false;
      images?.dispose();
      setReaderImages(null);
    };
  }, [bookId, runtime]);

  useLayoutEffect(() => {
    if (!bookId || !preferences || !measureBox.current || !pageBox.current || !animationBox.current)
      return;
    syncMeasureBox(pageBox.current, measureBox.current, effectiveMode === "double" ? 2 : 1);
    const presentation = new PageTurnAdapter(animationBox.current, {
      effect: preferences.pageTurnEffect,
      reducedMotion: Boolean(reducedMotion),
      pageClassName: "reader-prose reader-text reader-paper",
      screenClassName: "reader-paper reader-screen",
      backgroundImage: () => backgroundImage.current,
      pageBox: () => pageBox.current,
      gestureBox: () => gestureBox.current,
    });
    adapter.current = presentation;
    const measuring = new DomReaderMeasurer(measureBox.current);
    measuring.setHeadings(headingsRef.current);
    presentation.setHeadings(headingsRef.current);
    measurer.current = measuring;
    const reader = new ReaderController(runtime.services.reader, {
      measurer: measuring,
      maxUnits: 8192,
      reducedMotion: Boolean(reducedMotion),
      adapter: presentation,
      positions: runtime.positions,
      mode: effectiveMode,
    });
    setController(reader);
    const flushReader = async () => {
      synchronizeScroll.current?.();
      reader.stopNavigation();
      await pauseAutomatic();
      await flushDirectory();
      await reader.flush();
    };
    runtime.readerFlush = flushReader;
    // Native acceptance seeks by whole-book progress, which the Legado-style
    // menu does not offer; the hook exists only in native-test builds.
    if (import.meta.env.MODE === "native-test")
      Object.assign(window, {
        __gripreadSeekProgress: (progress: number) => reader.seekProgress(progress),
        __gripreadFlush: () => reader.flush(),
      });
    run(async () => {
      await imagesReady.current;
      await reader.open(bookId);
    });
    return () => {
      reader.dispose();
      adapter.current = null;
      if (runtime.readerFlush === flushReader) runtime.readerFlush = null;
    };
  }, [bookId, pauseAutomatic, flushDirectory, runtime, Boolean(preferences)]);
  useEffect(() => {
    void pauseAutomatic();
  }, [bookId, state.contentWindow?.contentVersion, pauseAutomatic]);
  useEffect(() => {
    if (state.error || state.saveError || libraryState.decoding) void pauseAutomatic();
  }, [state.error, state.saveError, libraryState.decoding, pauseAutomatic]);
  useEffect(() => {
    controller?.setReducedMotion(Boolean(reducedMotion));
    adapter.current?.setEffect(preferences?.pageTurnEffect ?? "instant");
  }, [controller, reducedMotion, preferences?.pageTurnEffect]);
  useLayoutEffect(() => {
    if (!controller) return;
    // The scroll text already reported its position while scrolling; by now
    // the new mode's layout is committed, so reading it again would record
    // an earlier line (setMode keeps the last reported position).
    void pauseAutomatic();
    if (pageBox.current && measureBox.current)
      syncMeasureBox(pageBox.current, measureBox.current, effectiveMode === "double" ? 2 : 1);
    run(() => controller.setMode(effectiveMode));
  }, [controller, effectiveMode, run, pauseAutomatic]);
  useEffect(() => {
    if (controller)
      run(() => controller.setDirectory(tools.loading || tools.error ? null : tools.toc));
  }, [controller, tools.loading, tools.error, tools.toc, run]);
  useEffect(() => {
    if (!automaticTurn.running) return;
    const pauseForSelection = () => {
      if (selectionActive()) void pauseAutomatic();
    };
    document.addEventListener("selectionchange", pauseForSelection);
    return () => document.removeEventListener("selectionchange", pauseForSelection);
  }, [automaticTurn.running, pauseAutomatic]);
  const layoutSignature = `${appearance.signature}|${headings.signature()}`;
  const pauseForLayout = useCallback(() => void pauseAutomatic(), [pauseAutomatic]);
  useReaderLayout(
    controller,
    pageBox,
    measureBox,
    layoutSignature,
    pauseForLayout,
    run,
    effectiveMode === "double" ? 2 : 1,
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[data-exit-pending="true"]')) return;
      if (event.key === "Escape" && !event.defaultPrevented && panel !== null) {
        event.preventDefault();
        event.stopPropagation();
        closePanel();
        return;
      }
      if (
        panel !== null ||
        closing ||
        document.querySelector('[role="dialog"][data-open]') ||
        event.defaultPrevented ||
        interactiveTarget(event.target) ||
        selectionActive() ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        // Like Android back in Legado: hide the reading menu before leaving.
        if (controls) setControls(false);
        else if (autoPanel) setAutoPanel(false);
        else void close();
      } else if (["ArrowRight", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        turn("next");
      } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        turn("previous");
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [panel, closePanel, closing, close, turn, controls, autoPanel]);

  // Volume keys turn pages while a book is open (Legado 音量键翻页). With the
  // reading menu or a tool open, or while reading aloud, they change the
  // volume again.
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const volumeTurns =
    Boolean(bookId) && volumeKeys && !controls && panel === null && aloud.state !== "playing";
  useEffect(() => {
    if (!volumeTurns) return;
    system.setVolumeKeys(true);
    const unsubscribe = system.onVolumeKey((direction) => turnRef.current(direction));
    return () => {
      unsubscribe();
      system.setVolumeKeys(false);
    };
  }, [volumeTurns]);
  // Hidden system bars return with the reading menu.
  useEffect(() => {
    if (!bookId || !hideBars) return;
    system.setSystemBarsHidden(!controls);
  }, [bookId, hideBars, controls]);
  useEffect(() => {
    if (!bookId || !hideBars) return;
    return () => system.setSystemBarsHidden(false);
  }, [bookId, hideBars]);

  /** The direction of a swipe for effects that turn only on release. */
  const swipe = useRef<"next" | "previous" | null>(null);
  const gestures: GestureHandlers = {
    tap: (action, point) => {
      // Legado: with the menu open, a tap anywhere on the page closes it.
      if (controls) {
        setControls(false);
        return;
      }
      if (action === "menu" && autoSession) setAutoPanel((shown) => !shown);
      else if (action === "menu") setControls(true);
      else if (action === "next" || action === "previous") {
        turn(action, point);
      } else if (action === "next-chapter" || action === "previous-chapter") {
        void pauseAutomatic();
        if (controller)
          run(() => controller.seekChapter(action === "next-chapter" ? "next" : "previous"));
      } else if (action === "contents" || action === "search") openPanel(action);
      else if (action === "bookmark") addBookmark();
    },
    dragStart: (direction, start) => {
      if (controls) {
        setControls(false);
        return false;
      }
      const current = controller?.getSnapshot();
      if (!controller || !current || current.loading) return false;
      if (direction === "next" ? !current.hasAfter : !current.hasBefore) return false;
      const presentation = adapter.current;
      if (!presentation?.followsDrag) {
        // The release turns through `turn`, which handles automatic turning.
        swipe.current = direction;
        return true;
      }
      const resume = interruptAutomatic();
      presentation.beginDrag(start);
      run(async () => {
        try {
          await (direction === "next" ? controller.next() : controller.previous());
        } finally {
          presentation.clearDrag();
        }
        // Released backwards: return to the page the drag started from.
        if (presentation.takeCancelled()) {
          presentation.skipNextAnimation();
          await (direction === "next" ? controller.previous() : controller.next());
        }
        resume();
      });
      return true;
    },
    dragMove: (point) => {
      if (!swipe.current) adapter.current?.updateDrag(point);
    },
    dragEnd: (commit, point) => {
      const direction = swipe.current;
      swipe.current = null;
      if (direction) {
        if (commit) turn(direction, point);
        return;
      }
      adapter.current?.endDrag(commit);
    },
  };

  if (!activeBook) return null;
  const page = state.page;
  const progress =
    page && page.totalLength ? Math.floor((page.startOffset / page.totalLength) * 100) : 0;
  const totalLength = state.contentWindow?.totalLength ?? activeBook.totalLength ?? 0;
  const info = {
    bookTitle: activeBook.book.title,
    chapterTitle: state.chapter?.title ?? "",
    chapterProgress: state.chapterProgress,
    bookProgress: bookProgressOf(state.contentWindow, page),
  };
  const typeStyle = appearance.text;
  const seekTo = (locator: Bookmark["locator"]) => {
    fromDetail.current = false;
    closePanel();
    setControls(false);
    if (controller) run(() => controller.seek(locator));
  };
  const highlightIn = (resourceId: string | undefined) => {
    const mark = search.highlight;
    return mark && (!mark.resourceId || mark.resourceId === resourceId) ? mark : null;
  };
  const openMatch = (index: number) => {
    const match = search.matches[index];
    if (!match) return;
    setSearchIndex(index);
    search.setHighlight({
      start: match.matchStart,
      end: match.matchEnd,
      resourceId: match.locator.resourceId,
    });
    seekTo(match.locator);
  };
  const canStartAutomatic =
    Boolean(controller) &&
    state.hasAfter &&
    !state.loading &&
    !state.error &&
    !state.saveError &&
    !closing &&
    !libraryState.decoding;

  return (
    <div
      className="fixed inset-0 z-50 reader-paper reader-screen flex flex-col"
      style={appearance.root}
      data-title-mode={style?.titleMode ?? "left"}
      data-reader-effect={reducedMotion ? "instant" : preferences?.pageTurnEffect}
      data-reader-mode={state.mode}
      data-reader-position={page?.startOffset}
      data-reader-loading={state.loading ? "true" : "false"}
      data-reader-automatic={automaticTurn.running ? "true" : "false"}
      data-chapter-start={state.chapter?.start}
      data-chapter-end={state.chapter?.end}
      inert={closing}
    >
      {/* The menu's theme tokens follow the page when the style asks for it. */}
      <div className="contents" style={appearance.menu}>
        <ReaderTopBar
          visible={controls && !previewing}
          title={activeBook.book.title}
          subtitle={state.chapter?.title ?? t("shelf.wholeText")}
          closing={closing}
          onBack={() => void close()}
          onOpenPanel={openPanel}
          canBookmark={Boolean(page) && !closing}
          onAddBookmark={addBookmark}
          onRefreshDirectory={() => {
            if (activeBook.online) {
              toast(t("shelf.updating"));
              void updateOnlineToc(runtime.services.sources, [activeBook.book.id]).then(
                ([outcome]) => {
                  if (outcome?.error)
                    toast({
                      text: t("detail.updateFailed", { error: outcome.error }),
                      error: true,
                    });
                  else {
                    refreshingDirectory.current = true;
                    reloadTools();
                  }
                },
                (failure: unknown) => toast({ text: String(failure), error: true }),
              );
              return;
            }
            refreshingDirectory.current = true;
            toast(t("shelf.updating"));
            reloadTools();
          }}
          txtTools={!activeBook.online && activeBook.asset?.kind !== "epub"}
          onChangeSource={activeBook.online ? () => setChangingSource(true) : undefined}
          onCache={activeBook.online ? () => setCachingRange(true) : undefined}
          replaceEnabled={useReplaceRules}
          onToggleReplace={() => toggleBookReplace(!useReplaceRules)}
          conversion={style?.chineseConversion ?? "off"}
          onOpenConversion={() => setDialog("conversion")}
          onOpenTranslation={() => setDialog("translation")}
          onOpenTools={() => setDialog("tools")}
          onOpenDetail={() => {
            void pauseAutomatic();
            setDialog("detail");
          }}
        />
      </div>
      <ReaderSurface
        double={effectiveMode === "double"}
        scroll={effectiveMode === "scroll"}
        pageBox={pageBox}
        gestureBox={gestureBox}
        animationBox={animationBox}
        style={typeStyle}
        acceptsGestures={() => panelRef.current === null && !closing && Boolean(controller)}
        onInteract={() => {
          // Showing or hiding the automatic panel does not stop turning.
          if (!autoSession) void pauseAutomatic();
        }}
        gestures={gestures}
        zones={style?.tapZones as TapZones | undefined}
        margins={style?.margins}
        header={
          style && effectiveMode !== "scroll" ? (
            <ReaderInfoBar
              bar={style.header}
              values={info}
              margins={style.headerMargins}
              line={style.headerLine}
              position="header"
            />
          ) : undefined
        }
        footer={
          style && effectiveMode !== "scroll" ? (
            <ReaderInfoBar
              bar={style.footer}
              values={info}
              margins={style.footerMargins}
              line={style.footerLine}
              position="footer"
            />
          ) : undefined
        }
      >
        {state.scroll && state.scroll.totalLength > 0 && controller ? (
          <ReaderScrollText
            key={state.scrollRevision}
            window={state.scroll}
            controller={controller}
            viewport={scrollBox}
            synchronize={synchronizeScroll}
            before={state.scrollBefore}
            after={state.scrollAfter}
            highlight={highlightIn(state.scroll.resourceId)}
            headings={headings}
            onInteract={() => {
              // Showing or hiding the automatic panel does not stop turning.
              if (!autoSession) void pauseAutomatic();
            }}
            onUserScroll={() => {
              if (panelRef.current === null) setControls(false);
            }}
            run={run}
          />
        ) : (
          page && (
            <div className={`h-full ${effectiveMode === "double" ? "grid grid-cols-2 gap-8" : ""}`}>
              {state.pages.map((visible) => (
                <ReaderPageText
                  key={visible.startOffset}
                  page={visible}
                  bookId={state.bookId}
                  highlight={highlightIn(state.contentWindow?.resourceId)}
                  headings={headings}
                  layout={layoutSignature}
                />
              ))}
            </div>
          )
        )}
        {!page && state.loading && (
          <p role="status" className="text-sm text-secondary">
            {t("reader.loadingText")}
          </p>
        )}
        {!state.loading && state.contentWindow?.totalLength === 0 && (
          <p className="text-sm text-secondary">{t("reader.noText")}</p>
        )}
      </ReaderSurface>
      <div
        ref={measureBox}
        className="reader-measure reader-prose"
        aria-hidden="true"
        style={typeStyle}
      />
      {fontError && !state.error && panel === null && (
        <div
          role="status"
          className="fixed bottom-40 left-4 right-4 z-30 rounded-xl px-4 py-2 bg-error-container text-error text-xs break-words"
        >
          {fontError}
        </div>
      )}
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
            {t("common.retry")}
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
      <div className="contents" style={appearance.menu}>
        {system.available() && (
          <ReaderBrightnessBar
            visible={controls && panel === null && searchIndex === null && !previewing}
            value={brightness}
            onChange={setBrightness}
          />
        )}
      </div>
      <div className="contents" style={appearance.menu}>
        <ReaderBottomBar
          visible={controls && searchIndex === null && !previewing}
          previous={{
            // A book read chapter by chapter also moves into the resource before.
            disabled:
              !state.chapter ||
              (state.chapter === state.chapters[0] && !state.contentWindow?.previousResourceId) ||
              closing,
            onClick: () => {
              void pauseAutomatic();
              if (controller) run(() => controller.seekChapter("previous"));
            },
          }}
          next={{
            disabled:
              !state.chapter ||
              (state.chapter === state.chapters.at(-1) && !state.contentWindow?.nextResourceId) ||
              closing,
            onClick: () => {
              void pauseAutomatic();
              if (controller) run(() => controller.seekChapter("next"));
            },
          }}
          progress={state.chapterProgress}
          progressDisabled={!state.chapter}
          onProgressDraft={() => void pauseAutomatic()}
          onProgressCommit={(target) => {
            void pauseAutomatic();
            if (controller) run(() => controller.seekChapterProgress(target / 100));
          }}
          tools={style?.bottomTools ?? []}
          onTool={useTool}
          night={night}
        />
      </div>
      {searchIndex !== null && panel === null && (
        <SearchResultBar
          index={searchIndex}
          count={search.matches.length}
          hasMore={search.hasMore}
          onStep={(direction) => openMatch(searchIndex + direction)}
          onList={() => openPanel("search")}
          onExit={() => {
            setSearchIndex(null);
            search.setHighlight(null);
          }}
        />
      )}
      {(panel === "style" || panel === "settings") && (
        <StylePanel
          initialView={panel === "settings" ? "more" : "main"}
          preferences={preferences}
          night={night}
          onChange={changePreferences}
          fonts={runtime.services.settings}
          onPreview={setPreviewing}
          onClose={closePanel}
        />
      )}
      {panel === "contents" && (
        <ContentsPage
          bookTitle={activeBook.book.title}
          toc={tools.toc}
          ruleName={activeBook.online ? activeBook.online.book.sourceName : tools.tocRuleName}
          splitLongChapters={tools.tocSettings.splitLongChapters}
          position={page?.startOffset ?? state.scroll?.startOffset ?? 0}
          loading={tools.loading}
          error={tools.error}
          busy={tools.busy}
          bookmarks={tools.bookmarks}
          contentVersion={state.contentWindow?.contentVersion}
          onReload={reloadTools}
          onSeek={seekTo}
          onOpenBookmark={(bookmark) => {
            if (bookmark.contentVersion !== state.contentWindow?.contentVersion) {
              fail(t("reader.oldBookmark"));
              return;
            }
            seekTo(bookmark.locator);
          }}
          onEditBookmark={(bookmark) => setNoteDraft({ excerpt: bookmark.excerpt, bookmark })}
          onDeleteBookmark={(bookmark) =>
            run(async () => {
              await runtime.services.reader.deleteBookmark({ bookmarkId: bookmark.id });
              setBookmarks((current) => current.filter((item) => item.id !== bookmark.id));
            })
          }
          resourceId={activeBook.online ? state.contentWindow?.resourceId : undefined}
          txtTools={!activeBook.online && activeBook.asset?.kind !== "epub"}
          onOpenRules={() => panels.push("rules")}
          onToggleSplit={() =>
            void tools.saveTocSettings({
              ...tools.tocSettings,
              splitLongChapters: !tools.tocSettings.splitLongChapters,
            })
          }
          onClose={closePanel}
        />
      )}
      <SelectionMenu enabled={panel === null && !closing} actions={selectionActions} />
      {noteDraft && (
        <BookmarkNoteDialog
          excerpt={noteDraft.excerpt}
          note={"bookmark" in noteDraft ? noteDraft.bookmark.note : ""}
          editing={"bookmark" in noteDraft}
          onSave={saveNote}
          onClose={() => setNoteDraft(null)}
        />
      )}
      {panel === "aloud" && readAloud && (
        <ReadAloudDialog
          snapshot={aloud}
          status={speechStatus}
          onOpenSettings={speechEngine().openSettings}
          rate={speechOptions.rate}
          pitch={speechOptions.pitch}
          voice={speechOptions.voice}
          loadVoices={loadVoices}
          onPlay={() => {
            void pauseAutomatic();
            if (aloud.state === "paused") readAloud.resume();
            else readAloud.start();
          }}
          onPause={() => readAloud.pause()}
          onStop={() => readAloud.stop()}
          onSkip={(step) => readAloud.skip(step)}
          onTimer={(minutes) => readAloud.sleepAfter(minutes)}
          onSettings={(patch) => style && settingsStore.set({ style: { ...style, ...patch } })}
          onClose={closePanel}
        />
      )}
      {aloud.state !== "idle" && panel !== "aloud" && readAloud && (
        <div
          data-reader-control=""
          className="fixed z-30 right-3 bottom-[calc(1rem+var(--safe-bottom))] flex items-center gap-1 rounded-full bg-inverse-surface text-inverse-on-surface shadow-md pl-3 pr-1 py-1 text-xs"
        >
          <button type="button" className="py-1" onClick={() => openPanel("aloud")}>
            {aloud.state === "playing" ? t("reader.aloudPlaying") : t("reader.aloudPaused")}
          </button>
          <button
            type="button"
            aria-label={
              aloud.state === "playing" ? t("reader.aloudPause") : t("reader.aloudResume")
            }
            className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-white/10"
            onClick={() => (aloud.state === "playing" ? readAloud.pause() : readAloud.resume())}
          >
            <Icon name={aloud.state === "playing" ? "pause" : "play"} size={14} />
          </button>
          <button
            type="button"
            aria-label={t("reader.aloudStop")}
            className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-white/10"
            onClick={() => readAloud.stop()}
          >
            <Icon name="stop" size={12} />
          </button>
        </div>
      )}
      {panel === "replace" && (
        <ReplaceRulesPage
          service={runtime.services.reader}
          book={{ enabled: useReplaceRules, onToggle: toggleBookReplace }}
          onChanged={() => (replaceChanged.current = true)}
          onClose={() => {
            closePanel();
            if (replaceChanged.current) {
              replaceChanged.current = false;
              applyTransformsRef.current();
            }
          }}
        />
      )}
      {cloudProgress && (
        <CloudProgressDialog
          prompt={cloudProgress}
          toc={tools.toc}
          here={page?.locator ?? null}
          onAnswer={answerCloudProgress}
        />
      )}
      {cachingRange && activeBook.online && (
        <CacheRangeDialog
          book={activeBook}
          current={state.contentWindow?.resourceIndex ?? undefined}
          onClose={() => setCachingRange(false)}
        />
      )}
      {changingSource && activeBook.online && (
        <ChangeSourceDialog
          service={runtime.services.sources}
          book={activeBook}
          prepare={async () => {
            // The switch maps the place saved now, not an older one.
            await controller?.flush();
          }}
          onChanged={(result) => {
            setChangingSource(false);
            if (!bookId) return;
            // The old place belongs to the old source's text; never save it again.
            runtime.positions.forget(bookId);
            reloadTools();
            const target = result.locator;
            if (controller) run(() => (target ? controller.seek(target) : controller.open(bookId)));
          }}
          onClose={() => setChangingSource(false)}
        />
      )}
      {askShelf && (
        <Dialog open onOpenChange={(open) => !open && setAskShelf(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("reader.addToShelf")}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm">{t("reader.askAdd", { title: activeBook.book.title })}</p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const { toDetail } = askShelf;
                  shelfChoice.current = "leave";
                  setAskShelf(null);
                  close(toDetail);
                }}
              >
                {t("reader.dontAdd")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const { toDetail } = askShelf;
                  void runtime.services.sources.setOnShelf(activeBook.book.id, true).then(
                    () => {
                      void keepOnlineCover(runtime.services.sources, activeBook);
                      shelfChoice.current = "add";
                      setAskShelf(null);
                      close(toDetail);
                    },
                    (failure: unknown) => toast({ text: String(failure), error: true }),
                  );
                }}
              >
                {t("reader.addToShelf")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {translating !== null && (
        <span
          role="status"
          className="pointer-events-none fixed right-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-[55] rounded-full bg-surface-container/90 px-2 py-0.5 text-[11px] text-secondary shadow-sm"
        >
          {t("translation.book.running", { percent: translating })}
        </span>
      )}
      {dialog === "translation" && bookId && (
        <TranslationDialog
          bookId={bookId}
          online={Boolean(activeBook.online)}
          onChanged={localBook ? applyTransforms : reopen}
          onOpenSettings={() => setDialog("translationSettings")}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "translationSettings" && (
        <TranslationSettingsPage layer="z-[60]" onClose={() => setDialog("translation")} />
      )}
      {dialog === "conversion" && style && (
        <ConversionDialog
          value={style.chineseConversion}
          onChange={(chineseConversion) =>
            settingsStore.set({ style: { ...style, chineseConversion } })
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "tools" && style && (
        <BottomToolsDialog
          tools={style.bottomTools}
          onChange={(bottomTools) => settingsStore.set({ style: { ...style, bottomTools } })}
          onClose={() => {
            setDialog(null);
            void settingsStore.flush().catch(() => undefined);
          }}
        />
      )}
      {dialog === "detail" && (
        <BookDetailPage
          book={
            libraryState.books.find((item) => item.book.id === activeBook.book.id) ?? activeBook
          }
          inReader
          onRemoved={() => {
            setDialog(null);
            void close();
          }}
          onOpen={(target) => {
            setDialog(null);
            if (target === "contents") openPanel("contents");
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {replaceDraft && (
        <ReplaceRuleEditor
          rule={replaceDraft}
          service={runtime.services.reader}
          onSave={async (rule) => {
            await runtime.services.reader.saveReplaceRule(rule);
            setReplaceDraft(null);
            toast(t("reader.ruleAdded"));
            // A book with 替换净化 off turns it on to show the new rule.
            if (useReplaceRules) applyTransformsRef.current();
            else toggleBookReplace(true);
          }}
          onClose={() => setReplaceDraft(null)}
        />
      )}
      {panel === "search" && (
        <SearchPage
          search={search}
          toc={tools.toc}
          totalLength={totalLength}
          byResource={Boolean(activeBook.online)}
          onOpenMatch={openMatch}
          onClose={closePanel}
        />
      )}
      {panel === "rules" && (
        <TocRuleDialog
          loader={runtime.services.reader}
          rules={tools.rules}
          settings={tools.tocSettings}
          detectedName={tools.tocRuleName}
          busy={tools.busy}
          onSelect={(ruleId) => void tools.saveTocSettings({ ...tools.tocSettings, ruleId })}
          onToggleSplit={() =>
            void tools.saveTocSettings({
              ...tools.tocSettings,
              splitLongChapters: !tools.tocSettings.splitLongChapters,
            })
          }
          onSave={tools.saveRule}
          onDelete={(rule) => tools.deleteRule(rule.id)}
          onOrder={tools.orderRules}
          onImport={tools.importRules}
          onExport={tools.exportRules}
          onTest={tools.testRule}
          onClose={panels.back}
        />
      )}
      {panel === "encoding" && (
        <EncodingDialog
          encodingInfo={tools.encodingInfo}
          decoding={libraryState.decoding}
          decodeError={libraryState.decodeError}
          disabled={tools.savingSettings()}
          onChange={changeEncoding}
          onReassociate={() =>
            run(async () => {
              const next = await runtime.services.library.pickAndReassociateTxt(activeBook.book.id);
              if (next) setEncodingInfo(next);
            })
          }
          onCancelDecode={() => void runtime.library.cancelDecode()}
          onClose={closePanel}
        />
      )}
      {autoSession && autoPanel && panel === null && !controls && (
        <AutoPagePanel
          running={automaticTurn.running}
          scroll={effectiveMode === "scroll"}
          seconds={preferences?.autoPageSeconds ?? 8}
          speed={preferences?.autoScrollSpeed ?? 40}
          onInterval={(autoPageSeconds) => settingsStore.set({ autoPageSeconds })}
          onSpeed={(autoScrollSpeed) => settingsStore.set({ autoScrollSpeed })}
          onPause={() => void pauseAutomatic()}
          onResume={() => automaticTurn.start()}
          onMenu={() => {
            void pauseAutomatic();
            setAutoPanel(false);
            setControls(true);
          }}
          onExit={() => {
            void pauseAutomatic();
            setAutoSession(false);
            setAutoPanel(false);
          }}
          onActivity={() => setAutoActivity((count) => count + 1)}
        />
      )}
    </div>
  );
}

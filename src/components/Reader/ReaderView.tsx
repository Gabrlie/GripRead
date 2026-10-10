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
import {
  ReaderController,
  DomReaderMeasurer,
  PageTurnAdapter,
  emptyReaderSnapshot,
} from "../../reader";
import type { ReaderSnapshot } from "../../reader";
import type { Bookmark, TxtEncoding } from "../../types/generated";
import { Button } from "../ui/button";
import { useAutomaticTurn } from "./use-automatic-turn";
import { useReaderActions } from "./use-reader-actions";
import { useReaderLayout, syncMeasureBox } from "./use-reader-layout";
import { useReaderPanel, type ReaderPanel } from "./use-reader-panel";
import { useReaderSearch } from "./use-reader-search";
import { useReaderTools } from "./use-reader-tools";
import { ReaderPageText } from "./ReaderPageText";
import { ReaderScrollText } from "./ReaderScrollText";
import { ReaderSurface, interactiveTarget, selectionActive } from "./ReaderSurface";
import { ReaderBottomBar, ReaderTopBar } from "./ReaderToolbar";
import { SettingsPanel } from "./panels/SettingsPanel";
import { ContentsPage } from "./pages/ContentsPage";
import { SearchPage, SearchResultBar } from "./pages/SearchPage";
import { TocRuleDialog } from "./dialogs/TocRuleDialog";
import { EncodingDialog } from "./dialogs/EncodingDialog";
import { AutomaticDialog } from "./dialogs/AutomaticDialog";

const empty: ReaderSnapshot = { ...emptyReaderSnapshot(), loading: true };
const noopSubscribe = () => () => {};

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
  const scrollBox = useRef<HTMLDivElement>(null);
  const synchronizeScroll = useRef<(() => void) | null>(null);
  const adapter = useRef<PageTurnAdapter | null>(null);
  const [controller, setController] = useState<ReaderController | null>(null);
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? (() => empty),
  );
  const [controls, setControls] = useState(false);
  const [closing, setClosing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const preferences = settings.value;
  const bookId = activeBook?.book.id;
  const effectiveMode =
    preferences?.readingMode === "double" && viewportWidth < 900
      ? "single"
      : (preferences?.readingMode ?? "single");
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
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
  const { cancel: cancelSearch } = search;
  const onPanelClose = useCallback(
    (closed: ReaderPanel) => {
      // Results stay for the result bar; only a running search stops.
      if (closed === "search") cancelSearch();
      // Previewed adjustments are written at once when their panel closes.
      if (closed === "style") void settingsStore.flush().catch(() => undefined);
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
              if (scrollBox.current) scrollBox.current.scrollTop += pixels;
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
  const openPanel = useCallback(
    (next: ReaderPanel) => {
      void pauseAutomatic();
      setControls(true);
      openPanelState(next);
    },
    [openPanelState, pauseAutomatic],
  );
  const turn = useCallback(
    (direction: "next" | "previous", point?: { x: number; y: number }) => {
      void pauseAutomatic();
      adapter.current?.aim(point ?? null);
      if (effectiveMode === "scroll") {
        if (scrollBox.current)
          scrollBox.current.scrollTop +=
            scrollBox.current.clientHeight * (direction === "next" ? 0.9 : -0.9);
        return;
      }
      if (controller) run(() => (direction === "next" ? controller.next() : controller.previous()));
    },
    [controller, effectiveMode, pauseAutomatic, run],
  );

  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    synchronizeScroll.current?.();
    void pauseAutomatic();
    controller?.dispose();
    runtime.finishReaderWrite(flushDirectory);
    runtime.finishReaderWrite(settingsStore.flush);
    closeReader();
    void runtime.positions
      .flush()
      .then(() => runtime.library.refresh())
      .catch(() => undefined);
  }, [
    controller,
    closing,
    closeReader,
    fail,
    flushDirectory,
    pauseAutomatic,
    runtime,
    settingsStore,
  ]);

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

  const { clearResults } = search;
  const changeEncoding = useCallback(
    (encoding: TxtEncoding) => {
      if (!bookId || !controller || tools.savingSettings()) return;
      const epoch = sessionEpoch.current;
      void pauseAutomatic();
      setSearchIndex(null);
      run(async () => {
        clearResults();
        await controller.flush();
        const next = await runtime.library.decodeTxt(bookId, encoding);
        if (epoch !== sessionEpoch.current) return;
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

  useLayoutEffect(() => {
    if (!bookId || !preferences || !measureBox.current || !pageBox.current || !animationBox.current)
      return;
    syncMeasureBox(pageBox.current, measureBox.current, effectiveMode === "double" ? 2 : 1);
    const presentation = new PageTurnAdapter(animationBox.current, {
      effect: preferences.pageTurnEffect,
      reducedMotion: Boolean(reducedMotion),
      pageClassName: "reader-prose reader-text bg-surface text-on-surface",
    });
    adapter.current = presentation;
    const reader = new ReaderController(runtime.services.reader, {
      measurer: new DomReaderMeasurer(measureBox.current),
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
    run(() => reader.open(bookId));
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
    synchronizeScroll.current?.();
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
  const layoutSignature = [
    preferences?.fontSize,
    preferences?.lineHeight,
    preferences?.fontFamily,
  ].join("|");
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
  }, [panel, closePanel, closing, close, turn, controls]);

  if (!activeBook) return null;
  const page = state.page;
  const progress =
    page && page.totalLength ? Math.floor((page.startOffset / page.totalLength) * 100) : 0;
  const totalLength = state.contentWindow?.totalLength ?? activeBook.totalLength ?? 0;
  const night =
    preferences?.theme === "dark" ||
    (preferences?.theme === "system" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const typeStyle = {
    fontSize: `${preferences?.fontSize ?? 18}px`,
    lineHeight: preferences?.lineHeight ?? 1.8,
    fontFamily:
      preferences?.fontFamily === "sans"
        ? "system-ui, sans-serif"
        : '"Literata Variable", "Noto Serif SC Variable", serif',
  };
  const seekTo = (locator: Bookmark["locator"]) => {
    closePanel();
    setControls(false);
    if (controller) run(() => controller.seek(locator));
  };
  const openMatch = (index: number) => {
    const match = search.matches[index];
    if (!match) return;
    setSearchIndex(index);
    search.setHighlight({ start: match.matchStart, end: match.matchEnd });
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
      className="fixed inset-0 z-50 bg-surface text-on-surface flex flex-col"
      data-reader-effect={reducedMotion ? "instant" : preferences?.pageTurnEffect}
      data-reader-mode={state.mode}
      data-reader-position={page?.startOffset}
      data-reader-loading={state.loading ? "true" : "false"}
      data-reader-automatic={automaticTurn.running ? "true" : "false"}
      data-chapter-start={state.chapter?.start}
      data-chapter-end={state.chapter?.end}
      inert={closing}
    >
      <ReaderTopBar
        visible={controls}
        title={activeBook.book.title}
        subtitle={state.chapter?.title ?? "全文"}
        closing={closing}
        onBack={() => void close()}
        onOpenPanel={openPanel}
        canBookmark={Boolean(page) && !closing}
        onAddBookmark={addBookmark}
        onRefreshDirectory={reloadTools}
      />
      <ReaderSurface
        double={effectiveMode === "double"}
        scroll={effectiveMode === "scroll"}
        pageBox={pageBox}
        animationBox={animationBox}
        style={typeStyle}
        acceptsGestures={() => panelRef.current === null && !closing && Boolean(controller)}
        onInteract={() => void pauseAutomatic()}
        onTurn={turn}
        onToggleControls={() => setControls((value) => !value)}
      >
        {state.scroll && state.scroll.totalLength > 0 && controller ? (
          <ReaderScrollText
            key={state.scrollRevision}
            window={state.scroll}
            controller={controller}
            viewport={scrollBox}
            synchronize={synchronizeScroll}
            highlight={search.highlight}
            onInteract={() => void pauseAutomatic()}
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
                  highlight={search.highlight}
                />
              ))}
            </div>
          )
        )}
        {!page && state.loading && (
          <p role="status" className="text-sm text-secondary">
            正在读取正文…
          </p>
        )}
        {!state.loading && state.contentWindow?.totalLength === 0 && (
          <p className="text-sm text-secondary">这本 TXT 暂无正文。</p>
        )}
      </ReaderSurface>
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
      <ReaderBottomBar
        visible={controls && searchIndex === null}
        previous={{
          disabled: !state.chapter || state.chapter === state.chapters[0] || closing,
          onClick: () => {
            void pauseAutomatic();
            if (controller) run(() => controller.seekChapter("previous"));
          },
        }}
        next={{
          disabled: !state.chapter || state.chapter === state.chapters.at(-1) || closing,
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
        onOpenPanel={openPanel}
        night={night}
        onToggleNight={() => settingsStore.set({ theme: night ? "light" : "dark" })}
      />
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
      {panel === "style" && (
        <SettingsPanel
          preferences={preferences}
          onChange={settingsStore.set}
          onClose={closePanel}
        />
      )}
      {panel === "contents" && (
        <ContentsPage
          bookTitle={activeBook.book.title}
          toc={tools.toc}
          ruleName={tools.tocRuleName}
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
              fail("该书签属于旧正文版本，请从目录重新定位。");
              return;
            }
            seekTo(bookmark.locator);
          }}
          onDeleteBookmark={(bookmark) =>
            run(async () => {
              await runtime.services.reader.deleteBookmark({ bookmarkId: bookmark.id });
              setBookmarks((current) => current.filter((item) => item.id !== bookmark.id));
            })
          }
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
      {panel === "search" && (
        <SearchPage
          search={search}
          toc={tools.toc}
          totalLength={totalLength}
          onOpenMatch={openMatch}
          onClose={closePanel}
        />
      )}
      {panel === "rules" && (
        <TocRuleDialog
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
      {panel === "automatic" && (
        <AutomaticDialog
          onClose={closePanel}
          scroll={effectiveMode === "scroll"}
          speed={preferences?.autoScrollSpeed ?? 40}
          onSpeed={(autoScrollSpeed) => settingsStore.set({ autoScrollSpeed })}
          seconds={preferences?.autoPageSeconds ?? 8}
          disabledInterval={!preferences}
          running={automaticTurn.running}
          canStart={canStartAutomatic}
          onInterval={(autoPageSeconds) => settingsStore.set({ autoPageSeconds })}
          onPause={() => void pauseAutomatic()}
          onStart={() => {
            closePanel();
            setControls(false);
            automaticTurn.start();
          }}
        />
      )}
    </div>
  );
}

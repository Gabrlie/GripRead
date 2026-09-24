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
import type { Bookmark, TxtEncoding } from "../../types/generated";
import { Button } from "../ui/button";
import { useAutomaticTurn } from "./use-automatic-turn";
import { useReaderActions } from "./use-reader-actions";
import { useReaderLayout, syncMeasureBox } from "./use-reader-layout";
import { useReaderPanel, type ReaderPanel } from "./use-reader-panel";
import { useReaderSearch } from "./use-reader-search";
import { useReaderTools } from "./use-reader-tools";
import { ReaderPageText } from "./ReaderPageText";
import { ReaderSurface, interactiveTarget, selectionActive } from "./ReaderSurface";
import { ReaderBottomBar, ReaderTopBar } from "./ReaderToolbar";
import { PanelShell } from "./panels/PanelShell";
import { SettingsPanel } from "./panels/SettingsPanel";
import {
  AutomaticPanel,
  ContentsPanel,
  DirectoryPanel,
  EncodingPanel,
  MorePanel,
  SearchPanel,
} from "./panels/ToolPanels";

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

const PANEL_TEXT: Record<Exclude<ReaderPanel, "settings">, [string, string]> = {
  contents: ["目录", "按正文位置跳转"],
  more: ["更多", "书签与阅读进度"],
  search: ["搜索正文", "在当前 TXT 中查找文字"],
  encoding: ["编码格式", "只在当前 TXT 内重新解码，不会上传正文"],
  directory: ["目录规则", "预览识别结果，再应用到本书目录"],
  automatic: ["自动翻页", "仅在阅读本书期间自动翻页"],
};

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
  const [closing, setClosing] = useState(false);
  const preferences = settings.value;
  const bookId = activeBook?.book.id;
  const actions = useReaderActions(bookId);
  const { run, fail, sessionEpoch, failedAction, actionError } = actions;
  const search = useReaderSearch(bookId, runtime.services.reader, run);
  const panelRef = useRef<ReaderPanel | null>(null);
  const directoryPanelOpen = useCallback(() => panelRef.current === "directory", []);
  const tools = useReaderTools(activeBook, runtime, actions, directoryPanelOpen);
  const { cancelPreview, flushDirectory } = tools;
  const { cancel: cancelSearch } = search;
  const onPanelClose = useCallback(
    (closed: ReaderPanel) => {
      if (closed === "directory") cancelPreview();
      if (closed === "search") cancelSearch();
      // Previewed adjustments are written at once when their panel closes.
      if (closed === "settings") void settingsStore.flush().catch(() => undefined);
    },
    [cancelPreview, cancelSearch, settingsStore],
  );
  const panels = useReaderPanel(onPanelClose);
  const { panel, open: openPanelState, close: closePanel } = panels;
  panelRef.current = panel;

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
    (direction: "next" | "previous") => {
      void pauseAutomatic();
      if (controller) run(() => (direction === "next" ? controller.next() : controller.previous()));
    },
    [controller, pauseAutomatic, run],
  );

  const close = useCallback(async () => {
    if (closing) return;
    setClosing(true);
    try {
      await pauseAutomatic();
      await flushDirectory();
      await controller?.flush();
      await settingsStore.flush();
      closeReader();
      void runtime.library.refresh();
    } catch (error) {
      fail(String(error));
      setClosing(false);
    }
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

  const { setBookmarks, setEncodingInfo, resetForDecode, reload: reloadTools } = tools;
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
      if (!bookId || !controller || tools.ruleOperation.current === "save") return;
      const epoch = sessionEpoch.current;
      void pauseAutomatic();
      resetForDecode();
      run(async () => {
        clearResults();
        await controller.flush();
        const next = await runtime.library.decodeTxt(bookId, encoding);
        if (epoch !== sessionEpoch.current) return;
        setEncodingInfo(next);
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
      resetForDecode,
      run,
      runtime,
      sessionEpoch,
      setEncodingInfo,
      tools.ruleOperation,
    ],
  );

  useLayoutEffect(() => {
    if (!bookId || !preferences || !measureBox.current || !pageBox.current || !animationBox.current)
      return;
    syncMeasureBox(pageBox.current, measureBox.current);
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
      await pauseAutomatic();
      await flushDirectory();
      await reader.flush();
    };
    runtime.readerFlush = flushReader;
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
  useReaderLayout(controller, pageBox, measureBox, layoutSignature, pauseForLayout, run);
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
        void close();
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
  }, [panel, closePanel, closing, close, turn]);

  if (!activeBook) return null;
  const page = state.page;
  const progress =
    page && page.totalLength ? Math.floor((page.startOffset / page.totalLength) * 100) : 0;
  const totalLength = state.contentWindow?.totalLength ?? activeBook.totalLength ?? 0;
  const typeStyle = {
    fontSize: `${preferences?.fontSize ?? 18}px`,
    lineHeight: preferences?.lineHeight ?? 1.8,
    fontFamily:
      preferences?.fontFamily === "sans"
        ? "system-ui, sans-serif"
        : '"Literata Variable", "Noto Serif SC Variable", serif',
  };
  const retryAction = failedAction.current
    ? () => failedAction.current && run(failedAction.current)
    : null;
  const status = {
    actionError,
    retryAction,
    toolsLoading: tools.loading,
    toolsError: tools.error,
    reloadTools,
  };
  const seekTo = (locator: Bookmark["locator"]) => {
    closePanel();
    if (controller) run(() => controller.seek(locator));
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
      inert={closing}
    >
      <ReaderTopBar
        visible={controls}
        title={activeBook.book.title}
        subtitle="全文"
        closing={closing}
        onBack={() => void close()}
        onOpenPanel={openPanel}
      />
      <ReaderSurface
        pageBox={pageBox}
        animationBox={animationBox}
        style={typeStyle}
        acceptsGestures={() => panelRef.current === null && !closing && Boolean(controller)}
        onInteract={() => void pauseAutomatic()}
        onTurn={turn}
        onToggleControls={() => setControls((value) => !value)}
      >
        {page && <ReaderPageText page={page} bookId={state.bookId} highlight={search.highlight} />}
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
        visible={controls}
        previous={{
          label: "上一页",
          disabled: !state.hasBefore || closing,
          onClick: () => turn("previous"),
        }}
        next={{
          label: "下一页",
          disabled: !state.hasAfter || closing,
          onClick: () => turn("next"),
        }}
        progress={progress}
        progressLabel="阅读进度"
        progressDisabled={!page || !page.totalLength}
        onProgressDraft={() => void pauseAutomatic()}
        onProgressCommit={(target) => {
          void pauseAutomatic();
          if (controller) run(() => controller.seekProgress(target / 100));
        }}
        onOpenPanel={openPanel}
      />
      {panel === "settings" && (
        <SettingsPanel
          preferences={preferences}
          onChange={settingsStore.set}
          onClose={closePanel}
          status={status}
        />
      )}
      {panel !== null && panel !== "settings" && (
        <PanelShell
          title={PANEL_TEXT[panel][0]}
          description={PANEL_TEXT[panel][1]}
          onClose={closePanel}
          status={status}
        >
          {panel === "encoding" && (
            <EncodingPanel
              encodingInfo={tools.encodingInfo}
              decoding={libraryState.decoding}
              decodeError={libraryState.decodeError}
              disabled={tools.ruleOperation.current === "save"}
              onChange={changeEncoding}
              onReassociate={() =>
                run(async () => {
                  const next = await runtime.services.library.pickAndReassociateTxt(
                    activeBook.book.id,
                  );
                  if (next) setEncodingInfo(next);
                })
              }
              onCancelDecode={() => void runtime.library.cancelDecode()}
            />
          )}
          {panel === "directory" && <DirectoryPanel tools={tools} totalLength={totalLength} />}
          {panel === "automatic" && (
            <AutomaticPanel
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
          {panel === "contents" && (
            <ContentsPanel
              toc={tools.toc}
              toolsLoading={tools.loading}
              toolsError={tools.error}
              onSeek={(entry) => seekTo(entry.locator)}
              onStart={() => {
                closePanel();
                if (controller) run(() => controller.seekProgress(0));
              }}
            />
          )}
          {panel === "more" && (
            <MorePanel
              bookmarks={tools.bookmarks}
              contentVersion={state.contentWindow?.contentVersion}
              canBookmark={Boolean(page) && !closing}
              canSave={Boolean(controller) && !closing}
              toolsLoading={tools.loading}
              toolsError={tools.error}
              onAddBookmark={addBookmark}
              onSave={() => {
                closePanel();
                if (controller) run(() => controller.flush());
              }}
              onOpenBookmark={(bookmark) => {
                if (bookmark.contentVersion !== state.contentWindow?.contentVersion) {
                  fail("该书签属于旧正文版本，请从目录或全文重新定位。");
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
            />
          )}
          {panel === "search" && (
            <SearchPanel
              search={search}
              onOpenMatch={(match) => {
                search.setHighlight({ start: match.matchStart, end: match.matchEnd });
                seekTo(match.locator);
              }}
            />
          )}
        </PanelShell>
      )}
    </div>
  );
}

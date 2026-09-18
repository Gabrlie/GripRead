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
import { useRuntime, useSettings } from "../../application/runtime";
import { ReaderController, DomReaderMeasurer, StPageFlipAdapter } from "../../reader";
import type { ReaderSnapshot } from "../../reader";
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

export function ReaderView() {
  const { activeBook, closeReader } = useApp();
  const runtime = useRuntime();
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
  const [closing, setClosing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftProgress, setDraftProgress] = useState<number | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const preferences = settings.value;
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
    let disposed = false;
    const reflow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !pageBox.current || !measureBox.current) return;
        const rect = pageBox.current.getBoundingClientRect();
        Object.assign(measureBox.current.style, {
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
        run(() => controller.reflow());
      });
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
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", reflow);
    };
  }, [controller, preferences?.fontSize, preferences?.lineHeight, preferences?.fontFamily, run]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
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
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [controller, panel, closing, run, close]);
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
              {page.text}
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
          <Button variant="ghost" aria-label="排版设置" onClick={() => setPanel(true)}>
            <Icon name="format_size" />
          </Button>
        </div>
      </div>
      <Dialog open={panel} onOpenChange={setPanel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>排版</DialogTitle>
            <DialogDescription>
              调整排版会保留当前阅读位置。目录识别与书签暂未开放。
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
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

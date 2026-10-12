import type {
  ContentWindow,
  ReaderLocator,
  WindowDirection,
  ReaderMode,
  TocEntry,
} from "../types/generated";
import type { ReaderService } from "../services/contracts";
import { isUtf16ScalarBoundary, windowStartsMidLine } from "./pagination";
import { continuesLine } from "./render";
import { ReaderPositions } from "./positions";
import { appLog } from "../services/log";
import { chapterRanges, chapterAt, type ReaderChapter } from "./chapters";
import type { ReaderMeasurer, ReaderPage } from "./pagination";
import type {
  ReaderDisplayedPage,
  ReaderNavigationDirection,
  ReaderPresentationAdapter,
  ReaderPresentationContext,
  ReaderSnapshot,
} from "./types";

/** Options used to construct a framework-independent reader controller. */
export interface ReaderControllerOptions {
  /** WebView-backed layout implementation used to find page boundaries. */
  measurer: ReaderMeasurer;
  /** Maximum number of UTF-16 units requested from the content service. */
  maxUnits?: number;
  /** Selects instant presentation when the operating system asks for it. */
  reducedMotion?: boolean;
  /** Optional page presentation adapter, such as PageTurnAdapter. */
  adapter?: ReaderPresentationAdapter;
  positions?: ReaderPositions;
  mode?: ReaderMode;
}

interface MeasuredWindow {
  readonly window: ContentWindow;
  readonly pages: readonly ReaderDisplayedPage[];
}

const MAX_WINDOW_UNITS = 1_000_000;
/** A chapter resource read whole to open it at its end. */
const WHOLE_RESOURCE_UNITS = 400_000;
const CONTEXT_UNITS = 32;

export function emptyReaderSnapshot(bookId: string | null = null): ReaderSnapshot {
  return {
    bookId,
    page: null,
    pages: [],
    mode: "single",
    chapters: [],
    chapter: null,
    chapterProgress: 0,
    scroll: null,
    scrollBefore: null,
    scrollAfter: null,
    scrollRevision: 0,
    contentWindow: null,
    pageIndex: 0,
    pageCount: 0,
    hasBefore: false,
    hasAfter: false,
    loading: false,
    error: null,
    saveError: null,
    positionWarning: null,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized) return serialized;
  } catch {
    // A value with a throwing toJSON is still given a useful generic message.
  }
  return "Reader operation failed";
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("A newer reader operation superseded this result", "AbortError");
  }
  const error = new Error("A newer reader operation superseded this result");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requiresRelocation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "content_version_mismatch"
  );
}

function isFiniteInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (index + 1 >= text.length || !isLowSurrogate(text.charCodeAt(index + 1))) {
        return false;
      }
      index += 1;
    } else if (isLowSurrogate(code)) {
      return false;
    }
  }
  return true;
}

/** Take a UTF-16 prefix without ending between the two units of a scalar. */
function safePrefix(text: string, maxUnits: number): string {
  let end = Math.min(text.length, Math.max(0, maxUnits));
  if (
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

/** Take a UTF-16 suffix without starting between the two units of a scalar. */
function safeSuffix(text: string, maxUnits: number): string {
  let start = Math.max(0, text.length - Math.max(0, maxUnits));
  if (
    start > 0 &&
    start < text.length &&
    isHighSurrogate(text.charCodeAt(start - 1)) &&
    isLowSurrogate(text.charCodeAt(start))
  ) {
    start += 1;
  }
  return text.slice(start);
}

/** Error raised when a service or measurer returns a non-contiguous window. */
export class ReaderProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReaderProtocolError";
  }
}

/**
 * Coordinates bounded content windows, measured pages, presentation, and
 * durable locators. The controller has no React dependency and can therefore
 * be exercised with a service and a deterministic measurer in unit tests.
 */
export class ReaderController {
  private readonly measurer: ReaderMeasurer;
  private readonly service: ReaderService;
  private readonly maxUnits: number;
  private readonly adapter: ReaderPresentationAdapter | undefined;
  private reducedMotion: boolean;

  private snapshot: ReaderSnapshot = emptyReaderSnapshot();
  private readonly listeners = new Set<() => void>();

  private windows: MeasuredWindow[] = [];
  private currentWindowIndex = -1;
  private currentPageIndex = -1;
  private activeBookId: string | null = null;

  /** Incremented by open and seeks so stale service results cannot commit. */
  private epoch = 0;
  private reflowToken = 0;
  private disposed = false;
  private navigationTail: Promise<void> = Promise.resolve();
  private mode: ReaderMode;
  private directory: readonly TocEntry[] | null = null;
  private directoryGeneration = 0;
  private scrollWindows: ContentWindow[] = [];
  private scrollRead: Promise<void> | null = null;
  private scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly positions: ReaderPositions;
  private readonly unsubscribePositions: () => void;
  /** Do not overwrite a stale saved locator until the user chooses a position. */
  private suppressPositionSave = false;

  /**
   * Arrow properties intentionally keep the methods bound for
   * useSyncExternalStore, whose callback is invoked without a receiver.
   */
  public readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getSnapshot = (): ReaderSnapshot => this.snapshot;

  public constructor(service: ReaderService, options: ReaderControllerOptions) {
    if (!options || !options.measurer) {
      throw new TypeError("ReaderController requires a DOM measurer");
    }
    const maxUnits = options.maxUnits ?? 8192;
    if (!isFiniteInteger(maxUnits) || maxUnits <= 0 || maxUnits > MAX_WINDOW_UNITS) {
      throw new RangeError(`maxUnits must be an integer between 1 and ${MAX_WINDOW_UNITS}`);
    }
    this.service = service;
    this.measurer = options.measurer;
    this.maxUnits = maxUnits;
    this.reducedMotion = Boolean(options.reducedMotion);
    this.adapter = options.adapter;
    this.mode = options.mode ?? "single";
    this.positions = options.positions ?? new ReaderPositions(service);
    this.unsubscribePositions = this.positions.subscribe(() => {
      this.snapshot = { ...this.snapshot, saveError: this.positions.errorFor(this.activeBookId) };
      this.notify();
    });
  }

  /** Open a book at its saved locator, or at the beginning when none exists. */
  public open(bookId: string): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    if (typeof bookId !== "string" || bookId.length === 0) {
      return Promise.reject(new TypeError("bookId must be a non-empty string"));
    }

    const epoch = ++this.epoch;
    this.activeBookId = bookId;
    this.windows = [];
    this.currentWindowIndex = -1;
    this.currentPageIndex = -1;
    this.snapshot = {
      ...emptyReaderSnapshot(bookId),
      loading: true,
    };
    this.notify();

    return this.schedule(epoch, async () => {
      const saved = await this.positions.load(bookId);
      this.assertCurrent(epoch);
      let positionWarning: string | null = null;
      let measured: MeasuredWindow;
      if (saved) {
        try {
          measured = await this.readAndMeasure(bookId, saved, "forward", epoch);
          this.suppressPositionSave = false;
        } catch (error) {
          if (!requiresRelocation(error)) throw error;
          positionWarning = "上次阅读位置属于旧正文版本，已从开头打开；可使用目录或搜索重新定位。";
          this.suppressPositionSave = true;
          measured = await this.readAndMeasure(bookId, null, "forward", epoch);
        }
      } else {
        this.suppressPositionSave = false;
        measured = await this.readAndMeasure(bookId, null, "forward", epoch);
      }
      this.assertCurrent(epoch);
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = pageIndexAt(measured.pages, saved?.offset ?? null);
      if (positionWarning) {
        this.currentPageIndex = 0;
        this.snapshot = { ...this.snapshot, positionWarning };
        this.notify();
      }
      await this.presentCurrent("open", epoch);
    });
  }

  /** Move to the next measured page, loading one adjacent bounded window when needed. */
  public next(): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    const epoch = this.epoch;
    this.adapter?.cancel?.();
    return this.schedule(epoch, () => this.performNext(epoch));
  }

  /** Move to the previous measured page, loading a window ending at the anchor when needed. */
  public previous(): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    const epoch = this.epoch;
    this.adapter?.cancel?.();
    return this.schedule(epoch, () => this.performPrevious(epoch));
  }

  /** Seek to a stable content locator and re-measure a bounded forward window. */
  public seek(locator: ReaderLocator): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    if (!locator || typeof locator.bookId !== "string") {
      return Promise.reject(new TypeError("seek requires a reader locator"));
    }
    const epoch = ++this.epoch;
    this.adapter?.cancel?.();
    this.activeBookId = locator.bookId;
    return this.schedule(epoch, async () => {
      this.setLoading(true);
      const measured = await this.readAndMeasure(locator.bookId, locator, "forward", epoch);
      this.assertCurrent(epoch);
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = pageIndexAt(measured.pages, locator.offset);
      this.suppressPositionSave = false;
      this.snapshot = { ...this.snapshot, positionWarning: null };
      await this.presentCurrent("seek", epoch);
    });
  }

  /** Resolve a fractional book position through the service, then seek to it. */
  public seekProgress(progress: number): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    if (!Number.isFinite(progress)) {
      return Promise.reject(new RangeError("progress must be finite"));
    }
    const bookId = this.activeBookId;
    if (!bookId) {
      return Promise.reject(new Error("cannot seek progress before opening a book"));
    }

    const epoch = ++this.epoch;
    this.adapter?.cancel?.();
    const boundedProgress = Math.min(1, Math.max(0, progress));
    return this.schedule(epoch, async () => {
      this.setLoading(true);
      const locator = await this.service.resolveLocator(bookId, boundedProgress);
      this.assertCurrent(epoch);
      const measured = await this.readAndMeasure(bookId, locator, "forward", epoch);
      this.assertCurrent(epoch);
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = pageIndexAt(measured.pages, locator.offset);
      this.suppressPositionSave = false;
      this.snapshot = { ...this.snapshot, positionWarning: null };
      await this.presentCurrent("seek", epoch);
    });
  }

  public setMode(mode: ReaderMode): Promise<void> {
    if (this.mode === mode && this.snapshot.mode === mode && !this.snapshot.error)
      return Promise.resolve();
    this.capturePosition();
    this.mode = mode;
    this.adapter?.cancel?.();
    return this.reflow();
  }

  public setDirectory(entries: readonly TocEntry[] | null): Promise<void> {
    if (this.directory === entries) return Promise.resolve();
    this.directory = entries;
    this.directoryGeneration++;
    return this.reflow();
  }

  public seekChapter(direction: "next" | "previous"): Promise<void> {
    const { chapters, chapter } = this.snapshot;
    const index = chapters.indexOf(chapter!);
    const target = chapters[index + (direction === "next" ? 1 : -1)];
    if (target) return this.seekChapterOffset(target.start, false);
    // A book read chapter by chapter keeps each chapter in its own resource.
    const window = this.snapshot.contentWindow;
    const resource = direction === "next" ? window?.nextResourceId : window?.previousResourceId;
    return window && resource ? this.seekResource(window.bookId, resource) : Promise.resolve();
  }

  /** Open a neighbouring chapter resource at its start. */
  private seekResource(bookId: string, resourceId: string): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    const epoch = ++this.epoch;
    this.adapter?.cancel?.();
    return this.schedule(epoch, async () => {
      this.setLoading(true);
      const measured = await this.readResource(bookId, resourceId, "forward", epoch);
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = 0;
      this.suppressPositionSave = false;
      this.snapshot = { ...this.snapshot, positionWarning: null };
      await this.presentCurrent("seek", epoch);
    });
  }

  /**
   * A neighbouring resource from its start. Entering it from its end
   * still paginates from the start, as Legado does, so the last page is
   * the one forward reading ends on instead of a short first page.
   */
  private async readResource(
    bookId: string,
    resourceId: string,
    direction: WindowDirection,
    epoch: number,
  ): Promise<MeasuredWindow> {
    const units = direction === "backward" ? WHOLE_RESOURCE_UNITS : undefined;
    return this.readAndMeasure(bookId, null, "forward", epoch, undefined, resourceId, units);
  }

  public seekChapterProgress(progress: number): Promise<void> {
    const chapter = this.snapshot.chapter;
    if (!chapter || !Number.isFinite(progress)) return Promise.resolve();
    const fraction = Math.max(0, Math.min(1, progress));
    const offset =
      fraction === 1
        ? chapter.end
        : chapter.start + Math.floor((chapter.end - chapter.start) * fraction);
    return this.seekChapterOffset(offset, fraction === 1);
  }

  private seekChapterOffset(offset: number, end: boolean): Promise<void> {
    const window = this.snapshot.contentWindow;
    if (!window) return Promise.resolve();
    const generation = this.directoryGeneration;
    const epoch = ++this.epoch;
    this.adapter?.cancel?.();
    return this.schedule(epoch, async () => {
      const locator = await this.service.resolveOffset({
        bookId: window.bookId,
        contentVersion: window.contentVersion,
        resourceId: window.resourceId,
        offset,
      });
      this.assertCurrent(epoch);
      if (generation !== this.directoryGeneration) throw abortError();
      const measured = await this.readAndMeasure(
        window.bookId,
        locator,
        end ? "backward" : "forward",
        epoch,
      );
      this.assertCurrent(epoch);
      if (generation !== this.directoryGeneration) throw abortError();
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = end
        ? Math.max(0, measured.pages.length - 1)
        : pageIndexAt(measured.pages, locator.offset);
      if (end && this.mode === "double" && this.currentPageIndex > 0) {
        const chapter = chapterAt(this.ranges(measured.window), offset - 1);
        if (measured.pages[this.currentPageIndex - 1].startOffset >= (chapter?.start ?? 0))
          this.currentPageIndex--;
      }
      // Scroll's renderer positions a chapter end after its DOM has been measured.
      if (end && this.mode === "scroll") {
        const chapter = chapterAt(this.ranges(measured.window), offset - 1);
        this.scrollTarget = { offset, start: chapter?.start ?? 0 };
      }
      this.suppressPositionSave = false;
      await this.presentCurrent("seek", epoch);
    });
  }

  private scrollTarget: { offset: number; start: number } | null = null;

  /**
   * Neighbouring chapter resources read and measured ahead, so turning into
   * them does not wait. Keyed by resource and the layout they were measured
   * for; any reflow, mode, or directory change makes them stale.
   */
  private neighbours = new Map<string, { layout: string; measured: Promise<MeasuredWindow> }>();

  private layoutKey(epoch: number): string {
    return `${epoch}|${this.mode}|${this.reflowToken}|${this.directoryGeneration}`;
  }

  /** A neighbour prepared for this layout, or a fresh read of it. */
  private neighbour(
    bookId: string,
    resourceId: string,
    direction: WindowDirection,
    epoch: number,
  ): Promise<MeasuredWindow> {
    const entry = this.neighbours.get(resourceId);
    this.neighbours.delete(resourceId);
    if (entry && entry.layout === this.layoutKey(epoch))
      return entry.measured.catch(() => this.readResource(bookId, resourceId, direction, epoch));
    this.setLoading(true);
    return this.readResource(bookId, resourceId, direction, epoch);
  }

  /** Starts reading the chapters around the visible page when it nears an edge. */
  private prepareNeighbours(epoch: number) {
    if (this.mode === "scroll") return;
    const measured = this.activeMeasuredWindow();
    if (!measured) return;
    const window = measured.window;
    const layout = this.layoutKey(epoch);
    for (const [key, entry] of this.neighbours)
      if (entry.layout !== layout) this.neighbours.delete(key);
    const index = this.currentPageIndex;
    const nearEnd = !window.hasAfter && index >= measured.pages.length - 3;
    const nearStart = !window.hasBefore && index <= 2;
    const wanted: [string | undefined, WindowDirection][] = [
      [nearEnd ? window.nextResourceId : undefined, "forward"],
      [nearStart ? window.previousResourceId : undefined, "backward"],
    ];
    for (const [resourceId, direction] of wanted) {
      if (!resourceId || this.neighbours.has(resourceId)) continue;
      const pending = this.readResource(window.bookId, resourceId, direction, epoch);
      // A failed or superseded read is simply not used.
      pending.catch(() => this.neighbours.delete(resourceId));
      this.neighbours.set(resourceId, { layout, measured: pending });
    }
  }
  public takeScrollTarget() {
    const target = this.scrollTarget;
    this.scrollTarget = null;
    return target;
  }

  private ranges(window: ContentWindow) {
    return this.directory === null ? [] : chapterRanges(this.directory, window);
  }

  public capturePosition(): void {
    if (this.scrollSaveTimer !== null) {
      clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = null;
      if (this.snapshot.page && !this.suppressPositionSave)
        this.positions.queue(this.snapshot.page.locator);
    }
  }

  /** DOM layout reports visible scalar boundaries, never pixel-based persisted positions. */
  public updateScrollPosition(start: number, end: number): void {
    const window = this.snapshot.scroll;
    // A scroll view still on screen while another mode takes over reports
    // its reflowed layout, not the reader's place.
    if (this.mode !== "scroll") return;
    if (this.disposed || !window || start < window.startOffset || start >= window.endOffset) return;
    if (!isUtf16ScalarBoundary(window.text, start - window.startOffset)) return;
    end = Math.min(window.endOffset, Math.max(start + 1, end));
    if (!isUtf16ScalarBoundary(window.text, end - window.startOffset)) end++;
    if (start !== this.snapshot.page?.startOffset) {
      this.suppressPositionSave = false;
      this.clearPositionWarning();
    }
    const page = normalizePages(sliceWindow(window, start, end), [
      {
        text: window.text.slice(start - window.startOffset, end - window.startOffset),
        startOffset: start,
        endOffset: end,
        hasBefore: start > 0,
        hasAfter: end < window.totalLength,
      },
    ])[0];
    const chapter = chapterAt(this.snapshot.chapters, start);
    this.snapshot = {
      ...this.snapshot,
      page,
      pages: [page],
      chapter,
      chapterProgress: progressInChapter(chapter, start, end),
      hasBefore: start > 0 || Boolean(window.previousResourceId),
      hasAfter: end < window.totalLength || Boolean(window.nextResourceId),
    };
    this.notify();
    // Persist the latest passage periodically even during uninterrupted automatic scrolling.
    if (this.scrollSaveTimer === null)
      this.scrollSaveTimer = setTimeout(() => this.capturePosition(), 1000);
  }

  public extendScroll(
    direction: WindowDirection,
    canCommit: () => boolean = () => true,
  ): Promise<void> {
    if (this.scrollRead) return this.scrollRead;
    const windows = this.scrollWindows;
    const edge = direction === "forward" ? windows.at(-1) : windows[0];
    if (!edge) return Promise.resolve();
    if (direction === "forward" ? !edge.hasAfter : !edge.hasBefore)
      return this.readScrollNeighbour(edge, direction, canCommit);
    const epoch = this.epoch;
    const anchor = direction === "forward" ? edge.endOffset : edge.startOffset;
    const operation = this.service
      .readContentWindow({
        bookId: edge.bookId,
        locator: boundaryLocator(edge, anchor),
        maxUnits: this.maxUnits,
        direction,
      })
      .then((next) => {
        this.assertCurrent(epoch);
        if (this.mode !== "scroll" || this.scrollWindows !== windows || !canCommit()) return;
        validateWindowResponse(next, edge.bookId, boundaryLocator(edge, anchor), direction, anchor);
        const all = direction === "forward" ? [...windows, next] : [next, ...windows];
        if (all.length > 3 && this.snapshot.page) {
          if (direction === "forward" && this.snapshot.page.startOffset < all[1].startOffset)
            return;
          if (direction === "backward" && this.snapshot.page.endOffset > all[2].endOffset) return;
        }
        this.scrollWindows =
          all.length <= 3 ? all : direction === "forward" ? all.slice(1) : all.slice(0, 3);
        const combined = joinWindows(this.scrollWindows);
        this.snapshot = {
          ...this.snapshot,
          scroll: combined,
          contentWindow: combined,
          error: null,
        };
        this.notify();
      })
      .catch((error: unknown) => {
        if (epoch !== this.epoch || this.disposed) return;
        this.reportOperationError(epoch, error);
        throw error;
      })
      .finally(() => {
        if (this.scrollRead === operation) this.scrollRead = null;
      });
    this.scrollRead = operation;
    return operation;
  }

  /**
   * At a chapter resource's edge, the neighbouring chapter is read and
   * shown beyond it: the next one from its start, the previous one whole.
   */
  private readScrollNeighbour(
    edge: ContentWindow,
    direction: WindowDirection,
    canCommit: () => boolean,
  ): Promise<void> {
    const resourceId = direction === "forward" ? edge.nextResourceId : edge.previousResourceId;
    const kept = direction === "forward" ? this.snapshot.scrollAfter : this.snapshot.scrollBefore;
    if (!resourceId || kept?.resourceId === resourceId) return Promise.resolve();
    const windows = this.scrollWindows;
    const epoch = this.epoch;
    const operation = this.service
      .readContentWindow({
        bookId: edge.bookId,
        locator: null,
        maxUnits: direction === "forward" ? this.maxUnits : WHOLE_RESOURCE_UNITS,
        direction: "forward",
        resourceId,
      })
      .then((next) => {
        this.assertCurrent(epoch);
        if (this.mode !== "scroll" || this.scrollWindows !== windows || !canCommit()) return;
        if (next.bookId !== edge.bookId || next.resourceId !== resourceId) return;
        this.snapshot = {
          ...this.snapshot,
          ...(direction === "forward" ? { scrollAfter: next } : { scrollBefore: next }),
        };
        this.notify();
      })
      .catch((error: unknown) => {
        if (epoch !== this.epoch || this.disposed) return;
        this.reportOperationError(epoch, error);
        throw error;
      })
      .finally(() => {
        if (this.scrollRead === operation) this.scrollRead = null;
      });
    this.scrollRead = operation;
    return operation;
  }

  /**
   * The scroll view's top passed into the chapter shown before or after:
   * it becomes the current chapter, and the one left stays shown beside it.
   * Returns whether there was such a chapter.
   */
  public enterScrollChapter(direction: WindowDirection): boolean {
    const target = direction === "forward" ? this.snapshot.scrollAfter : this.snapshot.scrollBefore;
    if (this.mode !== "scroll" || this.disposed || !target || !this.scrollWindows.length)
      return false;
    const left = joinWindows(this.scrollWindows);
    this.scrollWindows = [target];
    this.scrollRead = null;
    this.snapshot = {
      ...this.snapshot,
      scroll: target,
      contentWindow: target,
      scrollBefore: direction === "forward" ? left : null,
      scrollAfter: direction === "forward" ? null : left,
      chapters: this.ranges(target),
      hasBefore: target.hasBefore || Boolean(target.previousResourceId),
      hasAfter: target.hasAfter || Boolean(target.nextResourceId),
      error: null,
    };
    this.notify();
    return true;
  }

  /** Re-measure from the current page's locator after a typography or viewport change. */
  public reflow(): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    // A reflow joins the navigation queue without superseding it: a pending
    // seek or turn must still complete, and the reflow then re-measures from
    // whatever page is current when it runs rather than when it was requested.
    const epoch = this.epoch;
    // Only a newer reflow supersedes this one; its layout is then obsolete.
    const token = ++this.reflowToken;
    const assertLatest = () => {
      if (token !== this.reflowToken) throw abortError();
    };
    return this.schedule(epoch, async () => {
      assertLatest();
      const current = this.snapshot.page;
      const bookId = this.activeBookId;
      // ReaderView calls reflow while its initial open is still pending. It is
      // safe to wait for the next ResizeObserver/font event in that case.
      if (!current || !bookId) {
        if (this.snapshot.contentWindow?.totalLength === 0) {
          this.snapshot = {
            ...this.snapshot,
            mode: this.mode,
            scroll: this.mode === "scroll" ? this.snapshot.contentWindow : null,
          };
          this.notify();
        }
        return;
      }
      const locator = { ...current.locator };
      this.setLoading(true);
      this.adapter?.resize?.();
      const measured = await this.readAndMeasure(bookId, locator, "forward", epoch);
      this.assertCurrent(epoch);
      assertLatest();
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = pageIndexAt(measured.pages, locator.offset);
      await this.presentCurrent("reflow", epoch);
    });
  }

  /** Update the motion preference without changing the current locator. */
  public stopNavigation(): void {
    this.capturePosition();
    this.epoch++;
    this.adapter?.cancel?.();
    this.navigationTail = Promise.resolve();
    this.restoreVisibleIndex();
    this.setLoading(false);
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = Boolean(reducedMotion);
    this.adapter?.setReducedMotion?.(this.reducedMotion);
  }

  /**
   * Wait for queued navigation and all pending saves. A failed save is
   * retried once on the next flush and then rejected with its original error.
   */
  public async flush(): Promise<void> {
    this.capturePosition();
    await this.navigationTail;
    await this.positions.flush();
  }

  /** Dispose presentation and measurement resources and invalidate owned work. */
  public dispose(): void {
    if (this.disposed) return;
    this.capturePosition();
    this.disposed = true;
    this.unsubscribePositions();
    this.epoch += 1;
    this.windows = [];
    this.currentWindowIndex = -1;
    this.currentPageIndex = -1;
    this.activeBookId = null;
    this.snapshot = emptyReaderSnapshot();
    this.listeners.clear();
    this.adapter?.dispose?.();
    const maybeDisposable = this.measurer as ReaderMeasurer & { dispose?: () => void };
    maybeDisposable.dispose?.();
  }

  private schedule<T>(epoch: number, operation: () => Promise<T>): Promise<T> {
    const run = this.navigationTail.then(
      async () => {
        try {
          this.assertCurrent(epoch);
          return await operation();
        } catch (error) {
          if (this.disposed || epoch !== this.epoch) throw abortError();
          this.reportOperationError(epoch, error);
          throw error;
        }
      },
      async () => {
        // navigationTail is deliberately kept fulfilled, but retain this
        // branch so a future implementation cannot starve queued actions.
        try {
          this.assertCurrent(epoch);
          return await operation();
        } catch (error) {
          if (this.disposed || epoch !== this.epoch) throw abortError();
          this.reportOperationError(epoch, error);
          throw error;
        }
      },
    );
    this.navigationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performNext(epoch: number): Promise<void> {
    try {
      const count = this.snapshot.pages.length || 1;
      for (let index = 0; index < count; index++) await this.moveForward(epoch);
      await this.presentCurrent("next", epoch);
      this.trimWindows();
    } catch (error) {
      this.restoreVisibleIndex();
      throw error;
    }
  }

  private async moveForward(epoch: number): Promise<void> {
    this.assertCurrent(epoch);
    const current = this.activeMeasuredWindow();
    const page = this.currentPage();
    if (!current || !page) return;
    if (!page.hasAfter) {
      const next = current.window.nextResourceId;
      if (!next) return;
      this.suppressPositionSave = false;
      this.clearPositionWarning();
      const measured = await this.neighbour(current.window.bookId, next, "forward", epoch);
      this.assertCurrent(epoch);
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = 0;
      return;
    }
    this.suppressPositionSave = false;
    this.clearPositionWarning();

    if (this.currentPageIndex + 1 < current.pages.length) {
      this.currentPageIndex += 1;
      return;
    }

    this.setLoading(true);
    const anchor = current.window.endOffset;
    let adjacent = this.windows[this.currentWindowIndex + 1];
    if (!adjacent || adjacent.window.startOffset !== anchor) {
      adjacent = await this.readAndMeasure(
        current.window.bookId,
        boundaryLocator(current.window, anchor),
        "forward",
        epoch,
        anchor,
      );
      this.assertCurrent(epoch);
      this.windows = [...this.windows.slice(0, this.currentWindowIndex + 1), adjacent];
    }
    this.currentWindowIndex += 1;
    this.currentPageIndex = pageIndexAt(adjacent.pages, anchor);
  }

  private async performPrevious(epoch: number): Promise<void> {
    try {
      const end = this.snapshot.page?.startOffset ?? 0;
      await this.moveBackward(epoch);
      const page = this.currentPage();
      const chapter = page ? chapterAt(this.snapshot.chapters, page.startOffset) : null;
      const before = this.windows
        .flatMap(({ pages }) => pages)
        .filter((item) => item.startOffset >= (chapter?.start ?? 0) && item.endOffset <= end);
      const oddEnding = before[0]?.startOffset === (chapter?.start ?? 0) && before.length % 2 === 1;
      if (this.mode === "double" && page && page.startOffset > (chapter?.start ?? 0) && !oddEnding)
        await this.moveBackward(epoch);
      await this.presentCurrent("previous", epoch, end);
      this.trimWindows();
    } catch (error) {
      this.restoreVisibleIndex();
      throw error;
    }
  }

  private restoreVisibleIndex() {
    const offset = this.snapshot.page?.startOffset;
    const index = this.windows.findIndex(({ pages }) =>
      pages.some((page) => page.startOffset === offset),
    );
    if (index >= 0) {
      this.currentWindowIndex = index;
      this.currentPageIndex = this.windows[index].pages.findIndex(
        (page) => page.startOffset === offset,
      );
    }
  }

  private async moveBackward(epoch: number): Promise<void> {
    this.assertCurrent(epoch);
    const current = this.activeMeasuredWindow();
    const page = this.currentPage();
    if (!current || !page) return;
    if (!page.hasBefore) {
      const previous = current.window.previousResourceId;
      if (!previous) return;
      this.suppressPositionSave = false;
      this.clearPositionWarning();
      const measured = await this.neighbour(current.window.bookId, previous, "backward", epoch);
      this.assertCurrent(epoch);
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = Math.max(0, measured.pages.length - 1);
      return;
    }
    this.suppressPositionSave = false;
    this.clearPositionWarning();

    if (this.currentPageIndex > 0) {
      this.currentPageIndex -= 1;
      return;
    }

    this.setLoading(true);
    const anchor = current.window.startOffset;
    let adjacent = this.windows[this.currentWindowIndex - 1];
    if (!adjacent || adjacent.window.endOffset !== anchor) {
      adjacent = await this.readAndMeasure(
        current.window.bookId,
        boundaryLocator(current.window, anchor),
        "backward",
        epoch,
        anchor,
      );
      this.assertCurrent(epoch);
      this.windows = [
        ...this.windows.slice(0, this.currentWindowIndex),
        adjacent,
        ...this.windows.slice(this.currentWindowIndex),
      ];
      this.currentWindowIndex += 1;
    }
    this.currentWindowIndex -= 1;
    this.currentPageIndex = Math.max(0, adjacent.pages.length - 1);
  }

  private async readAndMeasure(
    bookId: string,
    locator: ReaderLocator | null,
    direction: WindowDirection,
    epoch: number,
    backwardAnchor?: number,
    resourceId?: string,
    maxUnits = this.maxUnits,
  ): Promise<MeasuredWindow> {
    this.assertCurrent(epoch);
    const window = await this.service.readContentWindow({
      bookId,
      locator,
      maxUnits,
      direction,
      ...(resourceId ? { resourceId } : {}),
    });
    this.assertCurrent(epoch);
    validateWindowResponse(window, bookId, locator, direction, backwardAnchor, resourceId);

    // A locator at the exact end of a non-empty book has no forward text.
    // Re-read a suffix ending at that exclusive anchor so the last page can
    // be displayed and progress=1 does not leave the reader stuck.
    if (
      direction === "forward" &&
      locator !== null &&
      window.text.length === 0 &&
      window.totalLength > 0 &&
      locator.offset === window.totalLength
    ) {
      return this.readAndMeasure(bookId, locator, "backward", epoch, locator.offset);
    }
    if (window.text.length === 0 && window.totalLength > 0) {
      throw new ReaderProtocolError("non-empty content windows cannot be empty");
    }
    if (this.mode === "scroll") {
      return {
        window,
        pages: window.text
          ? normalizePages(window, [
              {
                text: window.text,
                startOffset: window.startOffset,
                endOffset: window.endOffset,
                hasBefore: window.hasBefore,
                hasAfter: window.hasAfter,
              },
            ])
          : [],
      };
    }
    const ranges = this.ranges(window);
    const cuts = [
      window.startOffset,
      ...ranges
        .map((range) => range.start)
        .filter((offset) => offset > window.startOffset && offset < window.endOffset),
      window.endOffset,
    ];
    const pages: ReaderDisplayedPage[] = [];
    const started = performance.now();
    for (let index = 0; index + 1 < cuts.length; index++) {
      const slice = sliceWindow(window, cuts[index], cuts[index + 1]);
      const measured = await Promise.resolve(this.measurer.measure(slice, direction));
      this.assertCurrent(epoch);
      pages.push(...normalizePages(slice, measured));
    }
    const spent = performance.now() - started;
    if (spent >= 50)
      appLog.write(
        "detail",
        "reader",
        `排版 ${window.text.length} 字用了 ${Math.round(spent)} ms，${pages.length} 页`,
      );
    return { window, pages };
  }

  private async presentCurrent(
    direction: ReaderNavigationDirection,
    epoch: number,
    visibleEnd = Infinity,
  ): Promise<void> {
    this.assertCurrent(epoch);
    const measured = this.activeMeasuredWindow();
    if (!measured) {
      this.setLoading(false);
      return;
    }
    const index = this.currentPageIndex < 0 ? 0 : this.currentPageIndex;
    this.currentPageIndex = Math.min(index, Math.max(0, measured.pages.length - 1));
    const displayed = this.currentPage();
    const chapters = this.ranges(measured.window);
    const chapter = displayed ? chapterAt(chapters, displayed.startOffset) : null;
    const visible = displayed ? [displayed] : [];
    if (
      displayed &&
      this.mode === "double" &&
      displayed.endOffset < Math.min(chapter?.end ?? displayed.totalLength, visibleEnd)
    ) {
      const originalWindow = this.currentWindowIndex;
      const originalPage = this.currentPageIndex;
      try {
        await this.moveForward(epoch);
        const right = this.currentPage();
        if (right && right !== displayed) visible.push(right);
      } finally {
        this.currentWindowIndex = originalWindow;
        this.currentPageIndex = originalPage;
      }
    }
    if (this.mode === "scroll") this.scrollWindows = [measured.window];
    this.snapshot = {
      ...this.snapshot,
      bookId: this.activeBookId,
      page: displayed,
      pages: visible,
      mode: this.mode,
      chapters,
      chapter,
      chapterProgress: progressInChapter(
        chapter,
        displayed?.startOffset ?? 0,
        visible.at(-1)?.endOffset ?? 0,
      ),
      scroll: this.mode === "scroll" ? measured.window : null,
      scrollBefore: null,
      scrollAfter: null,
      scrollRevision: this.snapshot.scrollRevision + (this.mode === "scroll" ? 1 : 0),
      contentWindow: measured.window,
      pageIndex: this.currentPageIndex < 0 ? 0 : this.currentPageIndex,
      pageCount: measured.pages.length,
      hasBefore:
        (displayed?.hasBefore ?? measured.window.hasBefore) ||
        Boolean(measured.window.previousResourceId),
      hasAfter:
        (visible.at(-1)?.hasAfter ?? measured.window.hasAfter) ||
        Boolean(measured.window.nextResourceId),
      loading: false,
      error: null,
    };
    if (displayed && (direction === "next" || direction === "previous")) this.adapter?.hold?.();
    this.notify();

    // Saving starts before presentation so a slow page-curl animation cannot
    // delay persistence or make the animation the owner of reading position.
    if (displayed && !this.suppressPositionSave) this.positions.queue(displayed.locator);
    this.prepareNeighbours(epoch);

    const context: ReaderPresentationContext = {
      index: this.currentPageIndex < 0 ? 0 : this.currentPageIndex,
      pages: measured.pages,
      reducedMotion: this.reducedMotion,
      visiblePages: visible,
      columns: this.mode === "double" ? 2 : 1,
    };
    await this.adapter?.setPages?.(measured.pages, context.index);
    this.assertCurrent(epoch);
    if (displayed) {
      await this.adapter?.present?.(displayed, direction, context);
    }
    this.assertCurrent(epoch);
  }

  private currentPage(): ReaderDisplayedPage | null {
    const measured = this.activeMeasuredWindow();
    if (!measured || measured.pages.length === 0) return null;
    if (this.currentPageIndex < 0 || this.currentPageIndex >= measured.pages.length) {
      return null;
    }
    return measured.pages[this.currentPageIndex] ?? null;
  }

  private activeMeasuredWindow(): MeasuredWindow | null {
    return this.windows[this.currentWindowIndex] ?? null;
  }

  private setLoading(loading: boolean): void {
    if (this.snapshot.loading === loading) return;
    this.snapshot = { ...this.snapshot, loading };
    this.notify();
  }

  private clearPositionWarning(): void {
    if (!this.snapshot.positionWarning) return;
    this.snapshot = { ...this.snapshot, positionWarning: null };
    this.notify();
  }

  private reportOperationError(epoch: number, error: unknown): void {
    if (this.disposed || epoch !== this.epoch || isAbortError(error)) return;
    this.snapshot = {
      ...this.snapshot,
      loading: false,
      error: errorMessage(error),
    };
    this.notify();
  }

  private trimWindows(): void {
    if (this.windows.length <= 3 || this.currentWindowIndex < 0) return;
    const start = Math.max(0, this.currentWindowIndex - 1);
    const end = Math.min(this.windows.length, this.currentWindowIndex + 2);
    this.windows = this.windows.slice(start, end);
    this.currentWindowIndex -= start;
  }

  private assertCurrent(epoch: number): void {
    if (this.disposed || epoch !== this.epoch) throw abortError();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function pageIndexAt(pages: readonly ReaderDisplayedPage[], anchor: number | null): number {
  if (pages.length === 0) return -1;
  if (anchor === null || !Number.isFinite(anchor)) return 0;
  const exact = pages.findIndex((page) => page.startOffset === anchor);
  if (exact >= 0) return exact;
  const containing = pages.findIndex(
    (page) => page.startOffset < anchor && anchor < page.endOffset,
  );
  if (containing >= 0) return containing;
  const next = pages.findIndex((page) => page.startOffset > anchor);
  return next >= 0 ? next : pages.length - 1;
}

function progressInChapter(chapter: ReaderChapter | null, start: number, end: number): number {
  if (!chapter || chapter.end === chapter.start) return 0;
  return end >= chapter.end
    ? 100
    : Math.min(
        99,
        Math.max(0, Math.floor(((start - chapter.start) / (chapter.end - chapter.start)) * 100)),
      );
}

function sliceWindow(window: ContentWindow, start: number, end: number): ContentWindow {
  return {
    ...window,
    text: window.text.slice(start - window.startOffset, end - window.startOffset),
    startOffset: start,
    endOffset: end,
    hasBefore: start > 0,
    hasAfter: end < window.totalLength,
    locator: boundaryLocator(window, start),
  };
}

function joinWindows(windows: readonly ContentWindow[]): ContentWindow {
  const first = windows[0];
  const last = windows[windows.length - 1];
  return {
    ...first,
    text: windows.map((window) => window.text).join(""),
    endOffset: last.endOffset,
    hasAfter: last.hasAfter,
  };
}

function boundaryLocator(window: ContentWindow, offset: number): ReaderLocator {
  const local = Math.max(0, Math.min(window.text.length, offset - window.startOffset));
  const before = `${window.locator.contextBefore}${window.text.slice(0, local)}`;
  return {
    ...window.locator,
    offset,
    contextBefore: safeSuffix(before, CONTEXT_UNITS),
    // No text after a window boundary is available to the frontend. The
    // service resolves the actual suffix from the content store.
    contextAfter:
      offset >= window.endOffset ? "" : safePrefix(window.text.slice(local), CONTEXT_UNITS),
  };
}

function normalizePages(
  window: ContentWindow,
  measured: ReaderPage[],
): readonly ReaderDisplayedPage[] {
  validateWindow(window);
  if (!Array.isArray(measured)) {
    throw new ReaderProtocolError("reader measurer must return an array of pages");
  }
  if (window.text.length === 0) {
    if (measured.length !== 0) {
      throw new ReaderProtocolError("empty content windows cannot contain pages");
    }
    return [];
  }
  if (measured.length === 0) {
    throw new ReaderProtocolError("reader measurer returned no page for non-empty text");
  }

  const pages: ReaderDisplayedPage[] = [];
  const windowContinued = windowStartsMidLine(window);
  let cursor = window.startOffset;
  for (const page of measured) {
    if (!page || typeof page.text !== "string") {
      throw new ReaderProtocolError("reader measurer returned an invalid page");
    }
    if (
      !isFiniteInteger(page.startOffset) ||
      !isFiniteInteger(page.endOffset) ||
      page.startOffset !== cursor ||
      page.endOffset <= page.startOffset
    ) {
      throw new ReaderProtocolError("reader pages must be ordered and contiguous");
    }
    const localStart = page.startOffset - window.startOffset;
    const localEnd = page.endOffset - window.startOffset;
    if (
      localStart < 0 ||
      localEnd > window.text.length ||
      !isUtf16ScalarBoundary(window.text, localStart) ||
      !isUtf16ScalarBoundary(window.text, localEnd) ||
      page.text !== window.text.slice(localStart, localEnd)
    ) {
      throw new ReaderProtocolError("reader page offsets do not match its text");
    }
    const locator = pageLocator(window, page.startOffset);
    pages.push({
      text: page.text,
      startOffset: page.startOffset,
      endOffset: page.endOffset,
      hasBefore: page.startOffset > 0,
      hasAfter: page.endOffset < window.totalLength,
      totalLength: window.totalLength,
      locator,
      continued: continuesLine(window.text, localStart, windowContinued),
    });
    cursor = page.endOffset;
  }
  if (cursor !== window.endOffset) {
    throw new ReaderProtocolError("reader pages do not cover the complete content window");
  }
  return pages;
}

function validateWindow(window: ContentWindow): void {
  if (
    !window ||
    typeof window.bookId !== "string" ||
    typeof window.resourceId !== "string" ||
    typeof window.contentVersion !== "string" ||
    typeof window.text !== "string" ||
    typeof window.hasBefore !== "boolean" ||
    typeof window.hasAfter !== "boolean"
  ) {
    throw new ReaderProtocolError("content service returned an invalid window");
  }
  if (
    !isFiniteInteger(window.startOffset) ||
    !isFiniteInteger(window.endOffset) ||
    !isFiniteInteger(window.totalLength) ||
    window.startOffset < 0 ||
    window.startOffset > window.endOffset ||
    window.endOffset > window.totalLength ||
    window.endOffset - window.startOffset !== window.text.length
  ) {
    throw new ReaderProtocolError("content window offsets are not UTF-16 contiguous");
  }
  if (
    !isUtf16ScalarBoundary(window.text, 0) ||
    !isUtf16ScalarBoundary(window.text, window.text.length)
  ) {
    throw new ReaderProtocolError("content window text contains an incomplete surrogate pair");
  }
  if (
    window.hasBefore !== window.startOffset > 0 ||
    window.hasAfter !== window.endOffset < window.totalLength
  ) {
    throw new ReaderProtocolError("content window boundary flags do not match its offsets");
  }
  if (
    !window.locator ||
    typeof window.locator.bookId !== "string" ||
    typeof window.locator.contentVersion !== "string" ||
    typeof window.locator.resourceId !== "string" ||
    typeof window.locator.contextBefore !== "string" ||
    typeof window.locator.contextAfter !== "string" ||
    !isFiniteInteger(window.locator.offset) ||
    window.locator.bookId !== window.bookId ||
    window.locator.contentVersion !== window.contentVersion ||
    window.locator.resourceId !== window.resourceId ||
    window.locator.offset !== window.startOffset
  ) {
    throw new ReaderProtocolError("content window locator does not match its resource");
  }
  if (
    !isWellFormedUtf16(window.locator.contextBefore) ||
    !isWellFormedUtf16(window.locator.contextAfter)
  ) {
    throw new ReaderProtocolError("content window locator contains an incomplete surrogate pair");
  }
}

function validateWindowResponse(
  window: ContentWindow,
  requestedBookId: string,
  locator: ReaderLocator | null,
  direction: WindowDirection,
  backwardAnchor?: number,
  resourceId?: string,
): void {
  validateWindow(window);
  if (window.bookId !== requestedBookId) {
    throw new ReaderProtocolError("content window belongs to another book");
  }
  if (resourceId !== undefined && locator === null) {
    // A neighbouring resource is read from its start or up to its end.
    if (window.resourceId !== resourceId) {
      throw new ReaderProtocolError("content window has a different resource");
    }
    const edge = direction === "forward" ? window.startOffset : window.endOffset;
    if (edge !== (direction === "forward" ? 0 : window.totalLength)) {
      throw new ReaderProtocolError("resource window does not start or end at its edge");
    }
    return;
  }
  if (locator) {
    if (locator.bookId !== requestedBookId) {
      throw new ReaderProtocolError("reader locator belongs to another book");
    }
    if (window.contentVersion !== locator.contentVersion) {
      throw new ReaderProtocolError("content window has a different content version");
    }
    if (window.resourceId !== locator.resourceId) {
      throw new ReaderProtocolError("content window has a different resource");
    }
  }
  if (direction === "forward") {
    const expectedStart = locator?.offset ?? 0;
    if (window.startOffset !== expectedStart) {
      throw new ReaderProtocolError(
        `forward content window started at ${window.startOffset}, expected ${expectedStart}`,
      );
    }
    return;
  }
  const expectedEnd = backwardAnchor ?? locator?.offset;
  if (expectedEnd === undefined || window.endOffset !== expectedEnd) {
    throw new ReaderProtocolError(
      `backward content window ended at ${window.endOffset}, expected exclusive anchor ${String(expectedEnd)}`,
    );
  }
}

function pageLocator(window: ContentWindow, offset: number): ReaderLocator {
  const local = offset - window.startOffset;
  const before = `${window.locator.contextBefore}${window.text.slice(0, local)}`;
  return {
    ...window.locator,
    offset,
    contextBefore: safeSuffix(before, CONTEXT_UNITS),
    // contextAfter belongs to the window anchor, so appending it here would
    // repeat text from the start of the window for pages near its end.
    contextAfter: safePrefix(window.text.slice(local), CONTEXT_UNITS),
  };
}

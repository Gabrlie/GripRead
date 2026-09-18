import type { ContentWindow, ReaderLocator, WindowDirection } from "../types/generated";
import type { ReaderService } from "../services/contracts";
import { isUtf16ScalarBoundary } from "./pagination";
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
  /** Optional page presentation adapter, such as StPageFlip. */
  adapter?: ReaderPresentationAdapter;
}

interface MeasuredWindow {
  readonly window: ContentWindow;
  readonly pages: readonly ReaderDisplayedPage[];
}

const MAX_WINDOW_UNITS = 1_000_000;
const CONTEXT_UNITS = 32;

function emptySnapshot(bookId: string | null = null): ReaderSnapshot {
  return {
    bookId,
    page: null,
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

interface SaveFailure {
  readonly locator: ReaderLocator;
  readonly error: unknown;
}

/** Keeps a save failure identifiable after the user opens another book. */
class ReaderSaveError extends Error {
  public constructor(
    message: string,
    public readonly locator: ReaderLocator,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = "ReaderSaveError";
  }
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

  private snapshot: ReaderSnapshot = emptySnapshot();
  private readonly listeners = new Set<() => void>();

  private windows: MeasuredWindow[] = [];
  private currentWindowIndex = -1;
  private currentPageIndex = -1;
  private activeBookId: string | null = null;

  /** Incremented by open/seek/reflow so stale service results cannot commit. */
  private epoch = 0;
  private disposed = false;
  private navigationTail: Promise<void> = Promise.resolve();

  /** The save worker drains at most the latest pending locator per turn. */
  private pendingSave: ReaderLocator | null = null;
  private saveWorker: Promise<void> | null = null;
  private readonly saveFailures = new Map<string, SaveFailure>();
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
      ...emptySnapshot(bookId),
      loading: true,
    };
    this.notify();

    return this.schedule(epoch, async () => {
      const previousSaveFailure = await this.awaitSavesBeforeOpen();
      this.assertCurrent(epoch);
      const saved = await this.service.getSavedReaderLocator(bookId);
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
      if (previousSaveFailure) {
        throw new ReaderSaveError(
          errorMessage(previousSaveFailure.error),
          previousSaveFailure.locator,
          previousSaveFailure.error,
        );
      }
    });
  }

  /** Move to the next measured page, loading one adjacent bounded window when needed. */
  public next(): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    const epoch = this.epoch;
    return this.schedule(epoch, () => this.performNext(epoch));
  }

  /** Move to the previous measured page, loading a window ending at the anchor when needed. */
  public previous(): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    const epoch = this.epoch;
    return this.schedule(epoch, () => this.performPrevious(epoch));
  }

  /** Seek to a stable content locator and re-measure a bounded forward window. */
  public seek(locator: ReaderLocator): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    if (!locator || typeof locator.bookId !== "string") {
      return Promise.reject(new TypeError("seek requires a reader locator"));
    }
    const epoch = ++this.epoch;
    this.activeBookId = locator.bookId;
    this.suppressPositionSave = false;
    return this.schedule(epoch, async () => {
      this.setLoading(true);
      const measured = await this.readAndMeasure(locator.bookId, locator, "forward", epoch);
      this.assertCurrent(epoch);
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = pageIndexAt(measured.pages, locator.offset);
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
    const boundedProgress = Math.min(1, Math.max(0, progress));
    this.suppressPositionSave = false;
    return this.schedule(epoch, async () => {
      this.setLoading(true);
      const locator = await this.service.resolveLocator(bookId, boundedProgress);
      this.assertCurrent(epoch);
      const measured = await this.readAndMeasure(bookId, locator, "forward", epoch);
      this.assertCurrent(epoch);
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = pageIndexAt(measured.pages, locator.offset);
      this.snapshot = { ...this.snapshot, positionWarning: null };
      await this.presentCurrent("seek", epoch);
    });
  }

  /** Re-measure from the current page's locator after a typography or viewport change. */
  public reflow(): Promise<void> {
    if (this.disposed) return Promise.reject(abortError());
    const current = this.currentPage();
    // ReaderView calls reflow while its initial open is still pending. It is
    // safe to wait for the next ResizeObserver/font event in that case.
    if (!current) return Promise.resolve();

    const epoch = ++this.epoch;
    const locator = { ...current.locator };
    const bookId = this.activeBookId;
    if (!bookId) return Promise.resolve();
    return this.schedule(epoch, async () => {
      this.setLoading(true);
      this.adapter?.resize?.();
      const measured = await this.readAndMeasure(bookId, locator, "forward", epoch);
      this.assertCurrent(epoch);
      this.windows = [measured];
      this.currentWindowIndex = 0;
      this.currentPageIndex = pageIndexAt(measured.pages, locator.offset);
      await this.presentCurrent("reflow", epoch);
    });
  }

  /** Update the motion preference without changing the current locator. */
  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = Boolean(reducedMotion);
    this.adapter?.setReducedMotion?.(this.reducedMotion);
  }

  /**
   * Wait for queued navigation and all pending saves. A failed save is
   * retried once on the next flush and then rejected with its original error.
   */
  public async flush(): Promise<void> {
    await this.navigationTail;

    await this.awaitPendingSaves();

    // A failed write is retried once by an explicit flush. Keep the retry
    // associated with its book so an old error cannot be attached to a new
    // book's visible state.
    for (const failure of this.saveFailures.values()) {
      this.pendingSave = { ...failure.locator };
      this.startSaveWorker();
      await this.awaitPendingSaves();
    }
    if (this.saveFailures.size > 0) {
      const failure = this.saveFailures.values().next().value as SaveFailure | undefined;
      if (failure) {
        throw new ReaderSaveError(errorMessage(failure.error), failure.locator, failure.error);
      }
    }
  }

  /** Dispose presentation and measurement resources and invalidate owned work. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.windows = [];
    this.currentWindowIndex = -1;
    this.currentPageIndex = -1;
    this.activeBookId = null;
    this.snapshot = emptySnapshot();
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
    this.assertCurrent(epoch);
    const current = this.activeMeasuredWindow();
    const page = this.currentPage();
    if (!current || !page) return;
    if (!page.hasAfter) return;
    this.suppressPositionSave = false;
    this.clearPositionWarning();

    if (this.currentPageIndex + 1 < current.pages.length) {
      this.currentPageIndex += 1;
      await this.presentCurrent("next", epoch);
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
    await this.presentCurrent("next", epoch);
    this.trimWindows();
  }

  private async performPrevious(epoch: number): Promise<void> {
    this.assertCurrent(epoch);
    const current = this.activeMeasuredWindow();
    const page = this.currentPage();
    if (!current || !page) return;
    if (!page.hasBefore) return;
    this.suppressPositionSave = false;
    this.clearPositionWarning();

    if (this.currentPageIndex > 0) {
      this.currentPageIndex -= 1;
      await this.presentCurrent("previous", epoch);
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
    await this.presentCurrent("previous", epoch);
    this.trimWindows();
  }

  private async readAndMeasure(
    bookId: string,
    locator: ReaderLocator | null,
    direction: WindowDirection,
    epoch: number,
    backwardAnchor?: number,
  ): Promise<MeasuredWindow> {
    this.assertCurrent(epoch);
    const window = await this.service.readContentWindow({
      bookId,
      locator,
      maxUnits: this.maxUnits,
      direction,
    });
    this.assertCurrent(epoch);
    validateWindowResponse(window, bookId, locator, direction, backwardAnchor);

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
    const pages = await Promise.resolve(this.measurer.measure(window, direction));
    this.assertCurrent(epoch);
    return { window, pages: normalizePages(window, pages) };
  }

  private async presentCurrent(direction: ReaderNavigationDirection, epoch: number): Promise<void> {
    this.assertCurrent(epoch);
    const measured = this.activeMeasuredWindow();
    if (!measured) {
      this.setLoading(false);
      return;
    }
    const index = this.currentPageIndex < 0 ? 0 : this.currentPageIndex;
    this.currentPageIndex = Math.min(index, Math.max(0, measured.pages.length - 1));
    const displayed = this.currentPage();
    this.snapshot = {
      ...this.snapshot,
      bookId: this.activeBookId,
      page: displayed,
      contentWindow: measured.window,
      pageIndex: this.currentPageIndex < 0 ? 0 : this.currentPageIndex,
      pageCount: measured.pages.length,
      hasBefore: displayed?.hasBefore ?? measured.window.hasBefore,
      hasAfter: displayed?.hasAfter ?? measured.window.hasAfter,
      loading: false,
      error: null,
    };
    this.notify();

    // Saving starts before presentation so a slow page-curl animation cannot
    // delay persistence or make the animation the owner of reading position.
    if (displayed && !this.suppressPositionSave) this.queueSave(displayed.locator);

    const context: ReaderPresentationContext = {
      index: this.currentPageIndex < 0 ? 0 : this.currentPageIndex,
      pages: measured.pages,
      reducedMotion: this.reducedMotion,
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
    if (error instanceof ReaderSaveError) {
      // The locator may belong to the book that was just left. The caller
      // still receives the rejection, while the new book keeps its own page
      // and error state intact.
      if (error.locator.bookId !== this.activeBookId) return;
      this.snapshot = {
        ...this.snapshot,
        loading: false,
        saveError: errorMessage(error.cause),
      };
      this.notify();
      return;
    }
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

  private async runSave(locator: ReaderLocator): Promise<void> {
    try {
      await this.service.saveReaderLocator(locator);
      this.saveFailures.delete(locator.bookId);
      if (!this.disposed && this.activeBookId === locator.bookId) {
        this.snapshot = { ...this.snapshot, saveError: null };
        this.notify();
      }
    } catch (error) {
      this.saveFailures.set(locator.bookId, {
        locator: { ...locator },
        error,
      });
      if (
        !this.disposed &&
        this.activeBookId === locator.bookId &&
        this.snapshot.bookId === locator.bookId
      ) {
        this.snapshot = { ...this.snapshot, saveError: errorMessage(error) };
        this.notify();
      }
    }
  }

  private async drainSaves(): Promise<void> {
    while (this.pendingSave) {
      const locator = this.pendingSave;
      this.pendingSave = null;
      await this.runSave(locator);
    }
  }

  private startSaveWorker(): void {
    if (this.saveWorker) return;
    const worker = this.drainSaves();
    this.saveWorker = worker;
    void worker.then(
      () => {
        if (this.saveWorker === worker) this.saveWorker = null;
      },
      () => {
        // drainSaves currently catches service failures. Keep the worker
        // self-healing if a future adapter throws outside runSave.
        if (this.saveWorker === worker) this.saveWorker = null;
      },
    );
  }

  private queueSave(locator: ReaderLocator): void {
    this.pendingSave = { ...locator };
    this.startSaveWorker();
  }

  private async awaitPendingSaves(): Promise<void> {
    let worker = this.saveWorker;
    while (worker) {
      await worker;
      worker = this.saveWorker;
    }
    if (this.pendingSave) {
      this.startSaveWorker();
      await this.awaitPendingSaves();
    }
  }

  private async awaitSavesBeforeOpen(): Promise<SaveFailure | null> {
    // An open replaces the active book. Complete all writes queued for the
    // previous book first. Return a failure for the caller to report after
    // the new book is displayed; attaching it before then would overwrite
    // the new book's loading or content state.
    await this.awaitPendingSaves();
    return this.saveFailures.values().next().value ?? null;
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
): void {
  validateWindow(window);
  if (window.bookId !== requestedBookId) {
    throw new ReaderProtocolError("content window belongs to another book");
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

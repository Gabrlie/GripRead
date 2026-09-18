import type {
  ReaderDisplayedPage,
  ReaderNavigationDirection,
  ReaderPresentationAdapter,
  ReaderPresentationContext,
} from "./types";

export interface InstantReaderAdapterOptions {
  /** Optional hook for a view that renders the current page itself. */
  onPresent?: (
    page: ReaderDisplayedPage,
    direction: ReaderNavigationDirection,
    context: ReaderPresentationContext,
  ) => void;
}

/**
 * Presentation adapter with no asynchronous transition. It is useful for
 * reduced-motion mode and for the ordinary React page already rendered by the
 * reader view. It records the last page only for diagnostics and tests.
 */
export class InstantReaderAdapter implements ReaderPresentationAdapter {
  private readonly onPresent: InstantReaderAdapterOptions["onPresent"];
  private pages: readonly ReaderDisplayedPage[] = [];
  private index = 0;
  private disposed = false;

  public constructor(options: InstantReaderAdapterOptions = {}) {
    this.onPresent = options.onPresent;
  }

  public setPages(pages: readonly ReaderDisplayedPage[], currentIndex: number): void {
    if (this.disposed) return;
    this.pages = pages;
    this.index = clampIndex(currentIndex, pages.length);
  }

  public present(
    page: ReaderDisplayedPage,
    direction: ReaderNavigationDirection,
    context: ReaderPresentationContext,
  ): void {
    if (this.disposed) return;
    this.index = clampIndex(context.index, context.pages.length);
    this.onPresent?.(page, direction, context);
  }

  public get currentPage(): ReaderDisplayedPage | null {
    return this.pages[this.index] ?? null;
  }

  public get currentIndex(): number {
    return this.index;
  }

  public get currentPages(): readonly ReaderDisplayedPage[] {
    return this.pages;
  }

  public dispose(): void {
    this.disposed = true;
    this.pages = [];
    this.index = 0;
  }
}

function clampIndex(index: number, pageCount: number): number {
  if (pageCount <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(pageCount - 1, Math.max(0, Math.trunc(index)));
}

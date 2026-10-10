import type { ContentWindow, PageTurnEffect, ReaderLocator, ReaderMode } from "../types/generated";
import type { ReaderPage } from "./pagination";
import type { ReaderChapter } from "./chapters";

/** Direction of a visible page turn. */
export type ReaderNavigationDirection = "next" | "previous" | "open" | "seek" | "reflow";

/** A measured page with a content locator at its first scalar boundary. */
export interface ReaderDisplayedPage extends ReaderPage {
  totalLength: number;
  locator: ReaderLocator;
  /** The page starts inside a line, so its first paragraph is not indented. */
  continued: boolean;
}

export interface ReaderPresentationContext {
  index: number;
  pages: readonly ReaderDisplayedPage[];
  reducedMotion: boolean;
  visiblePages?: readonly ReaderDisplayedPage[];
  columns?: 1 | 2;
}

/**
 * Visual page transitions are deliberately separate from content loading and
 * persistence. Adapters receive measured pages and never call ReaderService.
 */
export interface ReaderPresentationAdapter {
  setPages?(pages: readonly ReaderDisplayedPage[], currentIndex: number): void | Promise<void>;
  present?(
    page: ReaderDisplayedPage,
    direction: ReaderNavigationDirection,
    context: ReaderPresentationContext,
  ): void | Promise<void>;
  /** Change motion preference without changing the content position. */
  setReducedMotion?(reducedMotion: boolean): void;
  /** Change the selected page-turn effect without owning navigation state. */
  setEffect?(effect: PageTurnEffect): void;
  /** Reset visual geometry after the host viewport changes. */
  resize?(): void;
  cancel?(): void;
  /**
   * Called synchronously before an animated turn publishes its new page, so
   * the outgoing page stays visible until the animation draws its first frame.
   */
  hold?(): void;
  dispose?(): void;
}

/** Stable external state exposed by ReaderController.getSnapshot(). */
export interface ReaderSnapshot {
  bookId: string | null;
  page: ReaderDisplayedPage | null;
  pages: readonly ReaderDisplayedPage[];
  mode: ReaderMode;
  chapters: readonly ReaderChapter[];
  chapter: ReaderChapter | null;
  chapterProgress: number;
  scroll: ContentWindow | null;
  scrollRevision: number;
  contentWindow: ContentWindow | null;
  pageIndex: number;
  pageCount: number;
  hasBefore: boolean;
  hasAfter: boolean;
  loading: boolean;
  error: string | null;
  saveError: string | null;
  /** Set when a saved locator belongs to an older body and cannot be mapped. */
  positionWarning: string | null;
}

import type { ContentWindow, PageTurnEffect, ReaderLocator } from "../types/generated";
import type { ReaderPage } from "./pagination";

/** Direction of a visible page turn. */
export type ReaderNavigationDirection = "next" | "previous" | "open" | "seek" | "reflow";

/** A measured page with a content locator at its first scalar boundary. */
export interface ReaderDisplayedPage extends ReaderPage {
  totalLength: number;
  locator: ReaderLocator;
}

export interface ReaderPresentationContext {
  index: number;
  pages: readonly ReaderDisplayedPage[];
  reducedMotion: boolean;
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
  dispose?(): void;
}

/** Stable external state exposed by ReaderController.getSnapshot(). */
export interface ReaderSnapshot {
  bookId: string | null;
  page: ReaderDisplayedPage | null;
  contentWindow: ContentWindow | null;
  pageIndex: number;
  pageCount: number;
  hasBefore: boolean;
  hasAfter: boolean;
  loading: boolean;
  error: string | null;
  saveError: string | null;
}

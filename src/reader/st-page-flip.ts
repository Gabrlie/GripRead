import { PageFlip } from "page-flip";
import { animate, type AnimationPlaybackControls } from "motion";
import type { PageTurnEffect } from "../types/generated";
import { renderReaderText } from "./render";
import type {
  ReaderDisplayedPage,
  ReaderNavigationDirection,
  ReaderPresentationAdapter,
  ReaderPresentationContext,
} from "./types";

type PageFlipEventHandler = (...args: unknown[]) => void;

/** The small part of StPageFlip used by this adapter. */
export interface StPageFlipLike {
  loadFromHTML?(items: HTMLElement[] | NodeListOf<HTMLElement>): void;
  /** StPageFlip spells the update method with a lower-case `tml`. */
  updateFromHtml?(items: HTMLElement[] | NodeListOf<HTMLElement>): void;
  turnToPage?(page: number): void;
  flip?(page: number, corner?: "top" | "bottom"): void;
  flipNext?(corner?: "top" | "bottom"): void;
  flipPrev?(corner?: "top" | "bottom"): void;
  destroy?(): void;
  on?(event: string, handler: PageFlipEventHandler): unknown;
  off?(event: string, handler?: PageFlipEventHandler): unknown;
  getSettings?(): { flippingTime?: number };
  /** The patched render loop, stopped while no turn is animating. */
  getRender?(): { start?(): void; stop?(): void };
}

export interface StPageFlipAdapterOptions {
  /** Existing PageFlip instance, useful when the host owns construction. */
  pageFlip?: StPageFlipLike;
  /** Factory override for tests or a host with a separately bundled StPageFlip. */
  createPageFlip?: (element: HTMLElement, settings: StPageFlipSettings) => StPageFlipLike;
  width?: number;
  height?: number;
  flippingTime?: number;
  effect?: PageTurnEffect;
  reducedMotion?: boolean;
  /** Mount cloned, aria-hidden pages into this element instead of a new child. */
  mount?: HTMLElement;
  pageClassName?: string;
}

export interface StPageFlipSettings {
  width: number;
  height: number;
  size: "fixed";
  flippingTime: number;
  usePortrait: boolean;
  autoSize: boolean;
  drawShadow: boolean;
  useMouseEvents: boolean;
  disableFlipByClick: boolean;
  mobileScrollSupport: boolean;
  startPage: number;
}

interface Geometry {
  width: number;
  height: number;
}

/**
 * Presents only the two pages involved in a turn. The React page remains the
 * accessible and selectable source of truth; StPageFlip receives detached
 * text clones in an aria-hidden overlay and the overlay is hidden after the
 * transition completes.
 */
export class StPageFlipAdapter implements ReaderPresentationAdapter {
  private readonly host: HTMLElement;
  private readonly mount: HTMLElement;
  private readonly ownsMount: boolean;
  private readonly options: StPageFlipAdapterOptions;
  private readonly waitForBuiltInInit: boolean;
  private pageFlip: StPageFlipLike | null;
  private pageFlipRoot: HTMLElement | null = null;
  private geometry: Geometry | null = null;
  private loaded = false;
  private disposed = false;
  private reducedMotion: boolean;
  private effect: PageTurnEffect;
  private pages: readonly ReaderDisplayedPage[] = [];
  private index = 0;
  private previousIndex = 0;
  private previousPage: ReaderDisplayedPage | null = null;
  private currentPage: ReaderDisplayedPage | null = null;
  private animationTimer: ReturnType<typeof setTimeout> | null = null;
  private animationResolve: (() => void) | null = null;
  private animationOff: (() => void) | null = null;
  private animationToken = 0;
  private pageFlipReady: Promise<void> | null = null;
  private pageFlipInitCancel: (() => void) | null = null;
  private columns: 1 | 2 = 1;
  private currentSpread: readonly ReaderDisplayedPage[] = [];
  private previousSpread: readonly ReaderDisplayedPage[] = [];
  private motion: AnimationPlaybackControls | null = null;
  /** A static copy of the outgoing spread shown between publish and first frame. */
  private held: HTMLElement | null = null;
  private holdFrame = 0;

  public constructor(host: HTMLElement, options: StPageFlipAdapterOptions = {}) {
    if (!host) throw new TypeError("StPageFlipAdapter requires an overlay host");
    this.host = host;
    this.options = options;
    this.waitForBuiltInInit = !options.pageFlip && !options.createPageFlip;
    this.pageFlip = options.pageFlip ?? null;
    this.reducedMotion = Boolean(options.reducedMotion);
    this.effect = options.effect ?? "curl";

    if (options.mount) {
      this.mount = options.mount;
      this.ownsMount = false;
    } else {
      this.mount = host.ownerDocument.createElement("div");
      this.ownsMount = true;
      host.append(this.mount);
    }
    this.mount.setAttribute("aria-hidden", "true");
    Object.assign(this.mount.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      overflow: "hidden",
      visibility: "hidden",
    });
  }

  public setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = Boolean(reducedMotion);
    this.applyMotionSetting();
    if (this.reducedMotion) this.cancelAnimation(true);
  }

  public setEffect(effect: PageTurnEffect): void {
    if (this.effect !== effect) this.cancel();
    this.effect = effect;
    this.applyMotionSetting();
    if (this.effect === "instant") this.cancelAnimation(true);
  }

  public setPages(pages: readonly ReaderDisplayedPage[], currentIndex: number): void {
    if (this.disposed) return;
    this.cancelAnimation(this.animationResolve !== null);
    this.previousPage = this.currentPage;
    this.previousSpread = this.currentSpread;
    this.previousIndex = this.index;
    this.pages = pages;
    this.index = clampIndex(currentIndex, pages.length);
    this.currentPage = pages[this.index] ?? null;
    this.hideOverlay();
  }

  public async present(
    page: ReaderDisplayedPage,
    direction: ReaderNavigationDirection,
    context: ReaderPresentationContext,
  ): Promise<void> {
    if (this.disposed) return;
    const columns = context.columns ?? 1;
    if (this.columns !== columns) {
      this.cancelAnimation(true);
      this.resetPageFlip();
      this.columns = columns;
    }
    this.currentSpread = context.visiblePages ?? [page];
    const targetIndex = clampIndex(context.index, this.pages.length);
    const target = page ?? this.pages[targetIndex];
    const instant =
      this.reducedMotion ||
      context.reducedMotion ||
      this.effect === "instant" ||
      direction === "open" ||
      direction === "seek" ||
      direction === "reflow" ||
      !target ||
      !this.previousPage ||
      samePage(this.previousPage, target);

    if (instant) {
      this.cancelAnimation(true);
      this.releaseHold();
      this.index = targetIndex;
      this.currentPage = target ?? null;
      this.hideOverlay();
      return;
    }

    const previous = this.previousPage;
    if (!previous || !target) return;
    const forward =
      direction === "next" || (direction !== "previous" && targetIndex >= this.previousIndex);
    if (this.effect === "slide" || this.effect === "fade") {
      await this.presentMotion(forward);
      return;
    }
    const items: [ReaderDisplayedPage, ReaderDisplayedPage] = forward
      ? [previous, target]
      : [target, previous];
    const startPage = forward ? 0 : 1;
    const flip = this.ensurePageFlip();
    const spread = (pages: readonly ReaderDisplayedPage[]) => [pages[0] ?? null, pages[1] ?? null];
    this.loadPair(
      flip,
      this.columns === 2
        ? forward
          ? [...spread(this.previousSpread), ...spread(this.currentSpread)]
          : [...spread(this.currentSpread), ...spread(this.previousSpread)]
        : items,
      this.columns === 2 ? (forward ? 0 : 2) : startPage,
    );
    const ready = this.pageFlipReady;
    if (ready) await ready;
    // A preference change or resize may have destroyed the instance while the
    // built-in PageFlip was waiting for its asynchronous init event.
    if (this.disposed || flip !== this.pageFlip) return;
    const animation = this.waitForAnimation(flip);
    flip.getRender?.()?.start?.();
    this.mount.style.visibility = "visible";
    this.releaseHoldAfterFrame();
    if (forward) {
      if (flip.flipNext) {
        flip.flipNext("top");
      } else if (flip.flip) {
        flip.flip(1, "top");
      } else {
        flip.turnToPage?.(1);
        this.finishAnimationImmediately();
      }
    } else if (flip.flipPrev) {
      flip.flipPrev("bottom");
    } else if (flip.flip) {
      flip.flip(0, "bottom");
    } else {
      flip.turnToPage?.(0);
      this.finishAnimationImmediately();
    }
    await animation;
  }

  public get currentPageFlip(): StPageFlipLike | null {
    return this.pageFlip;
  }

  /**
   * Stops an animation without discarding the PageFlip instance, which is
   * reused by the next turn; only an instance still waiting for init resets.
   */
  public cancel(): void {
    this.cancelAnimation(true);
    this.releaseHold();
    if (this.pageFlipInitCancel) this.resetPageFlip();
  }

  public hold(): void {
    if (this.disposed || this.reducedMotion || this.effect === "instant") return;
    if (!this.currentSpread.length) return;
    this.releaseHold();
    const held = this.spreadElement(this.currentSpread);
    held.style.zIndex = "1";
    this.held = held;
    this.mount.append(held);
    this.mount.style.visibility = "visible";
  }

  private releaseHold(): void {
    cancelAnimationFrame(this.holdFrame);
    this.held?.remove();
    this.held = null;
  }

  /** PageFlip draws on animation frames; uncover it once it has painted. */
  private releaseHoldAfterFrame(): void {
    const held = this.held;
    if (!held) return;
    this.holdFrame = requestAnimationFrame(() => {
      this.holdFrame = requestAnimationFrame(() => {
        if (this.held === held) this.releaseHold();
      });
    });
  }

  private spreadElement(pages: readonly ReaderDisplayedPage[]): HTMLElement {
    const overlay = this.mount.ownerDocument.createElement("div");
    overlay.className = this.options.pageClassName ?? "reader-prose";
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      display: "grid",
      gridTemplateColumns: `repeat(${this.columns}, minmax(0, 1fr))`,
      gap: this.columns === 2 ? "32px" : "0",
    });
    for (const page of pages) overlay.append(this.createPageElement(page, false));
    return overlay;
  }

  private async presentMotion(forward: boolean): Promise<void> {
    this.resetPageFlip();
    const overlay = this.spreadElement(this.previousSpread);
    this.mount.append(overlay);
    this.mount.style.visibility = "visible";
    this.releaseHold();
    const finished = new Promise<void>((resolve) => {
      this.animationResolve = resolve;
    });
    this.motion = animate(
      overlay,
      this.effect === "fade" ? { opacity: [1, 0] } : { x: [0, forward ? "-100%" : "100%"] },
      {
        duration: 0.2,
        ease: "easeOut",
        onComplete: () => this.cancelAnimation(),
      },
    );
    await finished;
    overlay.remove();
  }

  /**
   * Invalidate the current geometry after a viewport change. The next
   * animated presentation creates a PageFlip instance with fresh dimensions.
   */
  public resize(): void {
    if (this.disposed) return;
    const wasAnimating = this.animationResolve !== null;
    this.cancelAnimation(wasAnimating);
    this.releaseHold();
    if (!wasAnimating) this.resetPageFlip();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAnimation(true);
    this.releaseHold();
    this.pages = [];
    this.previousPage = null;
    this.currentPage = null;
    this.loaded = false;
    this.index = 0;
    this.resetPageFlip();
    this.mount.replaceChildren();
    if (this.ownsMount && this.mount.parentNode) this.mount.remove();
  }

  private ensurePageFlip(): StPageFlipLike {
    const nextGeometry = this.readGeometry();
    if (this.pageFlip && this.geometry && !sameGeometry(this.geometry, nextGeometry)) {
      this.resetPageFlip();
    }
    if (this.pageFlip) {
      this.geometry = nextGeometry;
      return this.pageFlip;
    }

    const settings: StPageFlipSettings = {
      width: nextGeometry.width / this.columns,
      height: nextGeometry.height,
      size: "fixed",
      flippingTime: this.animationDuration(),
      usePortrait: this.columns === 1,
      autoSize: false,
      drawShadow: true,
      useMouseEvents: false,
      disableFlipByClick: true,
      mobileScrollSupport: false,
      startPage: 0,
    };
    const pageFlipRoot = this.mount.ownerDocument.createElement("div");
    Object.assign(pageFlipRoot.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    });
    this.mount.append(pageFlipRoot);
    try {
      this.pageFlip = this.options.createPageFlip
        ? this.options.createPageFlip(pageFlipRoot, settings)
        : new PageFlip(pageFlipRoot, settings);
      this.pageFlipRoot = pageFlipRoot;
    } catch (error) {
      pageFlipRoot.remove();
      throw error;
    }
    this.geometry = nextGeometry;
    this.applyMotionSetting();
    return this.pageFlip;
  }

  private loadPair(
    flip: StPageFlipLike,
    items: readonly (ReaderDisplayedPage | null)[],
    startPage: number,
  ): void {
    const elements = items.map((page, index) => {
      const element = this.createPageElement(page);
      if (this.columns === 2) element.style.paddingInline = index % 2 === 0 ? "0 16px" : "16px 0";
      return element;
    });
    if (!this.loaded) {
      if (!flip.loadFromHTML) {
        throw new Error("StPageFlip instance cannot load HTML pages");
      }
      flip.loadFromHTML(elements);
      this.loaded = true;
      this.pageFlipReady = this.waitForPageFlipInit(flip);
    } else {
      const update = flip.updateFromHtml;
      if (update) update.call(flip, elements);
      else if (flip.loadFromHTML) flip.loadFromHTML(elements);
      else throw new Error("StPageFlip instance cannot update HTML pages");
    }
    flip.turnToPage?.(startPage);
    this.applyMotionSetting();
  }

  private waitForAnimation(flip: StPageFlipLike): Promise<void> {
    this.cancelAnimation();
    const token = ++this.animationToken;
    return new Promise<void>((resolve) => {
      this.animationResolve = () => {
        if (this.animationTimer !== null) {
          clearTimeout(this.animationTimer);
          this.animationTimer = null;
        }
        this.animationResolve = null;
        this.animationOff?.();
        this.animationOff = null;
        flip.getRender?.()?.stop?.();
        this.hideOverlay();
        resolve();
      };
      const onFlip: PageFlipEventHandler = () => this.finishAnimation(token);
      if (flip.on) {
        flip.on("flip", onFlip);
        this.animationOff = () => flip.off?.("flip", onFlip);
      }
      // The flip event normally ends the turn; the timer only bounds a lost event.
      this.animationTimer = setTimeout(
        () => this.finishAnimation(token),
        this.animationDuration() + 250,
      );
    });
  }

  private finishAnimation(token: number): void {
    if (token !== this.animationToken) return;
    this.animationResolve?.();
  }

  private finishAnimationImmediately(): void {
    this.animationResolve?.();
  }

  private cancelAnimation(resetUnderlying: boolean = false): void {
    const wasAnimating = this.animationResolve !== null;
    this.animationToken += 1;
    this.motion?.stop();
    this.motion = null;
    if (this.animationTimer !== null) {
      clearTimeout(this.animationTimer);
      this.animationTimer = null;
    }
    this.animationOff?.();
    this.animationOff = null;
    const resolve = this.animationResolve;
    this.animationResolve = null;
    this.hideOverlay();
    resolve?.();
    if (resetUnderlying && wasAnimating) this.resetPageFlip();
  }

  private resetPageFlip(): void {
    this.pageFlipInitCancel?.();
    this.pageFlipInitCancel = null;
    this.pageFlip?.destroy?.();
    if (this.pageFlipRoot?.parentNode) this.pageFlipRoot.remove();
    this.pageFlip = null;
    this.pageFlipRoot = null;
    this.geometry = null;
    this.loaded = false;
    this.pageFlipReady = null;
    this.mount.replaceChildren(...(this.held ? [this.held] : []));
  }

  private waitForPageFlipInit(flip: StPageFlipLike): Promise<void> | null {
    const on = flip.on;
    if (!this.waitForBuiltInInit || !on) return null;
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (this.pageFlipInitCancel === cancel) this.pageFlipInitCancel = null;
        flip.off?.("init", onInit);
        resolve();
      };
      const cancel = () => finish();
      this.pageFlipInitCancel = cancel;
      const onInit: PageFlipEventHandler = () => finish();
      on.call(flip, "init", onInit);
      // PageFlip currently emits init on a short timer. Keep a bounded
      // fallback for WebKit versions that do not deliver that event.
      timer = setTimeout(finish, 100);
    });
  }

  private hideOverlay(): void {
    this.mount.style.visibility = this.held ? "visible" : "hidden";
  }

  private readGeometry(): Geometry {
    const rect = this.host.getBoundingClientRect();
    return {
      width: positive(this.options.width ?? (this.host.clientWidth || rect.width), "width"),
      height: positive(this.options.height ?? (this.host.clientHeight || rect.height), "height"),
    };
  }

  private animationDuration(): number {
    if (this.reducedMotion || this.effect === "instant") return 1;
    return Math.max(1, this.options.flippingTime ?? 650);
  }

  private applyMotionSetting(): void {
    const settings = this.pageFlip?.getSettings?.();
    if (settings) settings.flippingTime = this.animationDuration();
  }

  private createPageElement(page: ReaderDisplayedPage | null, gutter = true): HTMLElement {
    const element = this.mount.ownerDocument.createElement("div");
    element.className = this.options.pageClassName ?? "reader-page-flip";
    element.setAttribute("aria-hidden", "true");
    if (gutter && this.columns === 2) {
      element.style.boxSizing = "border-box";
      // Each leaf includes half the center gutter; text width matches measurement.
      element.style.paddingInline = "8px";
    }
    if (!page) return element;
    element.dataset.start = String(page.startOffset);
    element.dataset.end = String(page.endOffset);
    element.dataset.total = String(page.totalLength);
    renderReaderText(element, page.text, { continued: page.continued });
    element.style.pointerEvents = "none";
    return element;
  }
}

function samePage(left: ReaderDisplayedPage, right: ReaderDisplayedPage): boolean {
  return (
    left.locator.bookId === right.locator.bookId &&
    left.locator.resourceId === right.locator.resourceId &&
    left.locator.contentVersion === right.locator.contentVersion &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset
  );
}

function sameGeometry(left: Geometry, right: Geometry): boolean {
  return left.width === right.width && left.height === right.height;
}

function clampIndex(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`StPageFlip overlay requires a positive ${label}`);
  }
  return value;
}

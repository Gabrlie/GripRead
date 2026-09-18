import { PageFlip } from "page-flip";
import type { PageTurnEffect } from "../types/generated";
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
    this.effect = effect;
    this.applyMotionSetting();
    if (this.effect === "instant") this.cancelAnimation(true);
  }

  public setPages(pages: readonly ReaderDisplayedPage[], currentIndex: number): void {
    if (this.disposed) return;
    this.cancelAnimation(this.animationResolve !== null);
    this.previousPage = this.currentPage;
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
      this.index = targetIndex;
      this.currentPage = target ?? null;
      this.hideOverlay();
      return;
    }

    const previous = this.previousPage;
    if (!previous || !target) return;
    const forward =
      direction === "next" || (direction !== "previous" && targetIndex >= this.previousIndex);
    const items: [ReaderDisplayedPage, ReaderDisplayedPage] = forward
      ? [previous, target]
      : [target, previous];
    const startPage = forward ? 0 : 1;
    const flip = this.ensurePageFlip();
    this.loadPair(flip, items, startPage);
    const ready = this.pageFlipReady;
    if (ready) await ready;
    // A preference change or resize may have destroyed the instance while the
    // built-in PageFlip was waiting for its asynchronous init event.
    if (this.disposed || flip !== this.pageFlip) return;
    const animation = this.waitForAnimation(flip);
    this.mount.style.visibility = "visible";
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
   * Invalidate the current geometry after a viewport change. The next
   * animated presentation creates a PageFlip instance with fresh dimensions.
   */
  public resize(): void {
    if (this.disposed) return;
    const wasAnimating = this.animationResolve !== null;
    this.cancelAnimation(wasAnimating);
    if (!wasAnimating) this.resetPageFlip();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAnimation(true);
    this.pages = [];
    this.previousPage = null;
    this.currentPage = null;
    this.loaded = false;
    this.index = 0;
    this.pageFlip?.destroy?.();
    this.pageFlip = null;
    this.pageFlipRoot = null;
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
      width: nextGeometry.width,
      height: nextGeometry.height,
      size: "fixed",
      flippingTime: this.animationDuration(),
      usePortrait: true,
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
    items: readonly [ReaderDisplayedPage | null, ReaderDisplayedPage],
    startPage: number,
  ): void {
    const elements = items.map((page) => this.createPageElement(page));
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
        this.hideOverlay();
        resolve();
      };
      const onFlip: PageFlipEventHandler = () => this.finishAnimation(token);
      if (flip.on) {
        flip.on("flip", onFlip);
        this.animationOff = () => flip.off?.("flip", onFlip);
      }
      this.animationTimer = setTimeout(() => this.finishAnimation(token), this.animationDuration());
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
    this.pageFlip?.destroy?.();
    if (this.pageFlipRoot?.parentNode) this.pageFlipRoot.remove();
    this.pageFlip = null;
    this.pageFlipRoot = null;
    this.geometry = null;
    this.loaded = false;
    this.pageFlipReady = null;
    this.mount.replaceChildren();
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
        flip.off?.("init", onInit);
        resolve();
      };
      const onInit: PageFlipEventHandler = () => finish();
      on.call(flip, "init", onInit);
      // PageFlip currently emits init on a short timer. Keep a bounded
      // fallback for WebKit versions that do not deliver that event.
      timer = setTimeout(finish, 100);
    });
  }

  private hideOverlay(): void {
    this.mount.style.visibility = "hidden";
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

  private createPageElement(page: ReaderDisplayedPage | null): HTMLElement {
    if (!page) throw new Error("StPageFlip cannot render an empty page");
    const element = this.mount.ownerDocument.createElement("div");
    element.className = this.options.pageClassName ?? "reader-page-flip";
    element.setAttribute("aria-hidden", "true");
    element.dataset.start = String(page.startOffset);
    element.dataset.end = String(page.endOffset);
    element.dataset.total = String(page.totalLength);
    element.textContent = page.text;
    element.style.pointerEvents = "none";
    element.style.whiteSpace = "pre-wrap";
    element.style.overflowWrap = "anywhere";
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

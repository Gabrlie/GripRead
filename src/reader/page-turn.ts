import { animate, type AnimationPlaybackControls } from "motion";
import type { PageTurnEffect } from "../types/generated";
import { curlGeometry, drawCurl, rasterizePage, type Point } from "./curl";
import { renderReaderText } from "./render";
import type {
  ReaderDisplayedPage,
  ReaderNavigationDirection,
  ReaderPresentationAdapter,
  ReaderPresentationContext,
} from "./types";

export interface PageTurnAdapterOptions {
  effect?: PageTurnEffect;
  reducedMotion?: boolean;
  /** Mount aria-hidden overlays into this element instead of a new child. */
  mount?: HTMLElement;
  /** Classes for overlay page copies; they must match the visible page. */
  pageClassName?: string;
  /** Curl duration in milliseconds. */
  curlDuration?: number;
  /** Frame scheduling, replaceable in tests. */
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
}

/**
 * Presents page turns over the React page, which stays the accessible and
 * selectable source of truth. Overlays are aria-hidden copies of the pages
 * involved: Motion animates slide and fade, and curl is drawn on a canvas
 * from rasterized pages (`curl.ts`), so no third-party DOM flipbook keeps
 * state between turns.
 */
export class PageTurnAdapter implements ReaderPresentationAdapter {
  private readonly host: HTMLElement;
  private readonly mount: HTMLElement;
  private readonly ownsMount: boolean;
  private readonly options: PageTurnAdapterOptions;
  private readonly requestFrame: (callback: (time: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly now: () => number;
  private disposed = false;
  private reducedMotion: boolean;
  private effect: PageTurnEffect;
  private pages: readonly ReaderDisplayedPage[] = [];
  private index = 0;
  private previousIndex = 0;
  private previousPage: ReaderDisplayedPage | null = null;
  private currentPage: ReaderDisplayedPage | null = null;
  private columns: 1 | 2 = 1;
  private currentSpread: readonly ReaderDisplayedPage[] = [];
  private previousSpread: readonly ReaderDisplayedPage[] = [];
  private motion: AnimationPlaybackControls | null = null;
  private frame = 0;
  private overlay: HTMLElement | null = null;
  private finish: (() => void) | null = null;
  /** A static copy of the outgoing spread shown between publish and first frame. */
  private held: HTMLElement | null = null;
  /** Where the reader touched to start the next turn, in host coordinates. */
  private aimPoint: Point | null = null;

  public constructor(host: HTMLElement, options: PageTurnAdapterOptions = {}) {
    if (!host) throw new TypeError("PageTurnAdapter requires an overlay host");
    this.host = host;
    this.options = options;
    this.reducedMotion = Boolean(options.reducedMotion);
    this.effect = options.effect ?? "curl";
    const view = host.ownerDocument.defaultView;
    this.requestFrame =
      options.requestFrame ?? ((callback) => view?.requestAnimationFrame(callback) ?? 0);
    this.cancelFrame = options.cancelFrame ?? ((handle) => view?.cancelAnimationFrame(handle));
    this.now = options.now ?? (() => view?.performance.now() ?? Date.now());
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
    if (this.reducedMotion) this.cancel();
  }

  public setEffect(effect: PageTurnEffect): void {
    if (this.effect !== effect) this.cancel();
    this.effect = effect;
  }

  /** Records the touch that starts the next turn; curl lifts the nearer corner. */
  public aim(point: Point | null): void {
    this.aimPoint = point;
  }

  public setPages(pages: readonly ReaderDisplayedPage[], currentIndex: number): void {
    if (this.disposed) return;
    this.stopAnimation();
    this.previousPage = this.currentPage;
    this.previousSpread = this.currentSpread;
    this.previousIndex = this.index;
    this.pages = pages;
    this.index = clampIndex(currentIndex, pages.length);
    this.currentPage = pages[this.index] ?? null;
    this.updateVisibility();
  }

  public async present(
    page: ReaderDisplayedPage,
    direction: ReaderNavigationDirection,
    context: ReaderPresentationContext,
  ): Promise<void> {
    if (this.disposed) return;
    const columns = context.columns ?? 1;
    if (this.columns !== columns) {
      this.stopAnimation();
      this.columns = columns;
    }
    this.currentSpread = context.visiblePages ?? [page];
    const targetIndex = clampIndex(context.index, this.pages.length);
    const target = page ?? this.pages[targetIndex];
    const aim = this.aimPoint;
    this.aimPoint = null;
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
    this.index = targetIndex;
    this.currentPage = target ?? null;
    if (instant) {
      this.stopAnimation();
      this.releaseHold();
      return;
    }
    const forward =
      direction === "next" || (direction !== "previous" && targetIndex >= this.previousIndex);
    if (this.effect === "curl") await this.presentCurl(forward, aim);
    else await this.presentMotion(forward);
  }

  /** Ends any animation at once; the published page is already correct. */
  public cancel(): void {
    this.stopAnimation();
    this.releaseHold();
  }

  public hold(): void {
    if (this.disposed || this.reducedMotion || this.effect === "instant") return;
    if (!this.currentSpread.length) return;
    this.releaseHold();
    const held = this.spreadElement(this.currentSpread);
    held.style.zIndex = "1";
    this.held = held;
    this.mount.append(held);
    this.updateVisibility();
  }

  public resize(): void {
    this.cancel();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.pages = [];
    this.previousPage = null;
    this.currentPage = null;
    this.mount.replaceChildren();
    if (this.ownsMount && this.mount.parentNode) this.mount.remove();
  }

  private async presentMotion(forward: boolean): Promise<void> {
    this.stopAnimation();
    const overlay = this.spreadElement(this.previousSpread);
    this.mount.append(overlay);
    this.overlay = overlay;
    this.releaseHold();
    this.updateVisibility();
    const finished = this.finished();
    this.motion = animate(
      overlay,
      this.effect === "fade" ? { opacity: [1, 0] } : { x: [0, forward ? "-100%" : "100%"] },
      { duration: 0.2, ease: "easeOut", onComplete: () => this.stopAnimation() },
    );
    await finished;
  }

  private async presentCurl(forward: boolean, aim: Point | null): Promise<void> {
    this.stopAnimation();
    const rect = this.host.getBoundingClientRect();
    const width = rect.width || this.host.clientWidth;
    const height = rect.height || this.host.clientHeight;
    if (width <= 0 || height <= 0) {
      this.releaseHold();
      return;
    }
    const ratio = this.host.ownerDocument.defaultView?.devicePixelRatio || 1;
    const outgoing = this.rasterize(this.previousSpread, rect, ratio);
    const incoming = this.rasterize(this.currentSpread, rect, ratio);
    const canvas = this.host.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    });
    const context = canvas.getContext("2d");
    if (!context) {
      this.releaseHold();
      return;
    }
    this.mount.append(canvas);
    this.overlay = canvas;
    this.updateVisibility();
    const background = outgoing.background;
    // Legado lifts the corner nearest the touch; forward turns use the right edge.
    const top = aim !== null && aim.y < height / 2;
    const corner = { x: width, y: top ? 0 : height };
    const lifted = {
      x: Math.min(width - 1, aim?.x ?? width * 0.95),
      y: aim?.y ?? (top ? height * 0.05 : height * 0.95),
    };
    const away = { x: -width, y: corner.y };
    // Backward turns lay the previous page down: the forward curl in reverse.
    const [from, to] = forward ? [lifted, away] : [away, { x: width - 1, y: corner.y }];
    const frame = forward
      ? { current: outgoing.canvas, next: incoming.canvas }
      : { current: incoming.canvas, next: outgoing.canvas };
    const duration = Math.max(1, this.options.curlDuration ?? 450);
    const finished = this.finished();
    const started = this.now();
    const draw = (time: number) => {
      if (this.overlay !== canvas) return;
      const progress = Math.min(1, (time - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const touch = {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      };
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawCurl(
        context,
        { ...frame, background, width, height },
        curlGeometry(touch, corner, width),
      );
      // The canvas now shows the outgoing page; the held copy can go.
      this.releaseHold();
      if (progress >= 1) this.stopAnimation();
      else this.frame = this.requestFrame(draw);
    };
    draw(started);
    await finished;
  }

  private rasterize(
    pages: readonly ReaderDisplayedPage[],
    rect: DOMRect,
    ratio: number,
  ): { canvas: HTMLCanvasElement; background: string } {
    const element = this.spreadElement(pages);
    element.style.visibility = "hidden";
    this.mount.append(element);
    try {
      const background =
        element.ownerDocument.defaultView?.getComputedStyle(element).backgroundColor || "#ffffff";
      return { canvas: rasterizePage(element, rect, ratio), background };
    } finally {
      element.remove();
    }
  }

  private finished(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }

  private stopAnimation(): void {
    this.motion?.stop();
    this.motion = null;
    this.cancelFrame(this.frame);
    this.frame = 0;
    this.overlay?.remove();
    this.overlay = null;
    const finish = this.finish;
    this.finish = null;
    this.updateVisibility();
    finish?.();
  }

  private releaseHold(): void {
    this.held?.remove();
    this.held = null;
    this.updateVisibility();
  }

  private updateVisibility(): void {
    this.mount.style.visibility = this.held || this.overlay ? "visible" : "hidden";
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
    for (const page of pages) overlay.append(this.createPageElement(page));
    return overlay;
  }

  private createPageElement(page: ReaderDisplayedPage): HTMLElement {
    const element = this.mount.ownerDocument.createElement("div");
    element.className = this.options.pageClassName ?? "reader-prose";
    element.setAttribute("aria-hidden", "true");
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

function clampIndex(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}

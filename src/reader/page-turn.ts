import { animate, type AnimationPlaybackControls } from "motion";
import type { PageTurnEffect } from "../types/generated";
import { curlGeometry, drawCurl, rasterizePage, type Point } from "./curl";
import { renderReaderText } from "./render";
import { NO_HEADINGS, type HeadingIndex } from "./headings";
import type {
  ReaderDisplayedPage,
  ReaderNavigationDirection,
  ReaderPresentationAdapter,
  ReaderPresentationContext,
} from "./types";

export interface PageTurnAdapterOptions {
  effect?: PageTurnEffect;
  /** The loaded reading background image, if the style has one. */
  backgroundImage?: () => HTMLImageElement | null;
  reducedMotion?: boolean;
  /** Mount aria-hidden overlays into this element instead of a new child. */
  mount?: HTMLElement;
  /** Classes for overlay page copies; they must match the visible page. */
  pageClassName?: string;
  /** Duration of a full-width turn in milliseconds (Legado: 300). */
  turnDuration?: number;
  /**
   * The element pages are laid out in. Turns animate the whole host (the
   * reading screen), with page copies placed where this element is; without
   * it pages fill the host.
   */
  pageBox?: () => HTMLElement | null;
  /** The element gesture points are relative to; defaults to `pageBox`. */
  gestureBox?: () => HTMLElement | null;
  /** Class of the full-screen copy, which supplies the reading background. */
  screenClassName?: string;
  /** Frame scheduling, replaceable in tests. */
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
}

/** A finger-driven turn: the latest point and, once released, its outcome. */
interface Drag {
  start: Point;
  point: Point;
  release: boolean | null;
  /** Redraws the running turn after the finger moves or lifts. */
  wake: (() => void) | null;
}

type CanvasEffect = "curl" | "slide" | "cover";

/**
 * Presents page turns over the React page, which stays the accessible and
 * selectable source of truth. Curl, slide, and cover draw two rasterized
 * pages on a canvas, either animated or following a drag; fade animates an
 * aria-hidden copy with Motion. No third-party flipbook keeps state between
 * turns, so any cancellation settles at once.
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
  private drag: Drag | null = null;
  private headings: HeadingIndex = NO_HEADINGS;
  /** Header and footer copies of the outgoing screen, taken before it changed. */
  private outgoingChrome: HTMLElement[] | null = null;
  private cancelled = false;
  private skipNext = false;
  /** Legado's 自动翻页 reveal: the outgoing screen, clipped from the top. */
  private reveal: { copy: HTMLElement; line: HTMLElement } | null = null;

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

  /** Overlay copies mark chapter headings like the visible page. */
  public setHeadings(headings: HeadingIndex): void {
    this.headings = headings;
  }

  /** Records the touch that starts the next turn; curl lifts the nearer corner. */
  public aim(point: Point | null): void {
    this.aimPoint = point && this.toHost(point);
  }

  /** Gesture points arrive relative to the gesture box; turns use the host. */
  private toHost(point: Point): Point {
    const box = this.options.gestureBox?.() ?? this.options.pageBox?.();
    if (!box) return point;
    const origin = this.host.getBoundingClientRect();
    const frame = box.getBoundingClientRect();
    return { x: point.x + frame.left - origin.left, y: point.y + frame.top - origin.top };
  }

  /** Whether the selected effect follows a dragging finger (curl, slide, cover). */
  public get followsDrag(): boolean {
    return (
      !this.reducedMotion &&
      (this.effect === "curl" || this.effect === "slide" || this.effect === "cover")
    );
  }

  /** The next turn follows the finger from `start` until `endDrag`. */
  public beginDrag(start: Point): void {
    const at = this.toHost(start);
    this.aimPoint = at;
    this.drag = { start: at, point: at, release: null, wake: null };
  }

  public updateDrag(point: Point): void {
    if (!this.drag) return;
    this.drag.point = this.toHost(point);
    this.drag.wake?.();
  }

  /** Completes the dragged turn, or animates back when `commit` is false. */
  public endDrag(commit: boolean): void {
    if (!this.drag) return;
    this.drag.release = commit;
    this.drag.wake?.();
  }

  /** Whether the last dragged turn was released backwards; reading clears it. */
  public takeCancelled(): boolean {
    const cancelled = this.cancelled;
    this.cancelled = false;
    return cancelled;
  }

  /** Presents the next turn instantly, as when undoing a cancelled drag. */
  public skipNextAnimation(): void {
    this.skipNext = true;
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
    // The drag stays live for updates until its turn ends.
    const drag = this.drag;
    const skip = this.skipNext;
    this.skipNext = false;
    const instant =
      skip ||
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
      this.endDragTurn(drag);
      return;
    }
    const forward =
      direction === "next" || (direction !== "previous" && targetIndex >= this.previousIndex);
    if (this.effect === "fade") {
      await this.presentFade();
      return;
    }
    if (this.effect === "instant") return;
    try {
      await this.presentCanvas(this.effect, forward, aim, drag);
    } finally {
      this.endDragTurn(drag);
    }
  }

  /** Ends any animation at once; the published page is already correct. */
  /**
   * The controller cancels before every navigation, including the one a drag
   * starts, so a pending drag survives; its turn or `clearDrag` ends it.
   */
  public cancel(): void {
    this.outgoingChrome = null;
    this.stopAnimation();
    this.releaseHold();
  }

  /** Forgets a drag whose turn never started, such as at the end of the book. */
  public clearDrag(): void {
    this.drag = null;
  }

  private endDragTurn(drag: Drag | null): void {
    if (drag && this.drag === drag) this.drag = null;
  }

  public hold(): void {
    if (this.disposed || this.reducedMotion || this.effect === "instant") return;
    if (!this.currentSpread.length) return;
    this.releaseHold();
    this.outgoingChrome = this.captureChrome();
    const held = this.screenElement(this.currentSpread, this.outgoingChrome);
    held.style.zIndex = "1";
    this.held = held;
    this.mount.append(held);
    this.updateVisibility();
  }

  public resize(): void {
    this.cancel();
  }

  /**
   * Covers the screen with a copy of the current page before an automatic
   * turn, so the next page can be uncovered from the top by `setReveal`.
   * Navigation cancels do not remove it; `endReveal` does.
   */
  public beginReveal(): void {
    this.endReveal();
    if (this.disposed || !this.currentSpread.length) return;
    const copy = this.screenElement(this.currentSpread, this.captureChrome());
    copy.style.zIndex = "2";
    copy.dataset.reveal = "true";
    const line = copy.ownerDocument.createElement("div");
    line.setAttribute("aria-hidden", "true");
    Object.assign(line.style, {
      position: "absolute",
      left: "0",
      right: "0",
      top: "0",
      height: "1px",
      zIndex: "3",
      background: "var(--reader-fg, currentColor)",
      opacity: "0.45",
      boxShadow: "0 1px 4px rgb(0 0 0 / 0.25)",
    });
    this.mount.append(copy, line);
    this.reveal = { copy, line };
    this.updateVisibility();
  }

  /** Uncovers the incoming page down to `progress` (0–1) of the screen height. */
  public setReveal(progress: number): void {
    if (!this.reveal) return;
    const percent = Math.min(100, Math.max(0, progress * 100));
    this.reveal.copy.style.clipPath = `inset(${percent}% 0 0 0)`;
    this.reveal.line.style.top = `calc(${percent}% - 1px)`;
  }

  public endReveal(): void {
    this.reveal?.copy.remove();
    this.reveal?.line.remove();
    this.reveal = null;
    this.updateVisibility();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.endReveal();
    this.disposed = true;
    this.pages = [];
    this.previousPage = null;
    this.currentPage = null;
    this.mount.replaceChildren();
    if (this.ownsMount && this.mount.parentNode) this.mount.remove();
  }

  private async presentFade(): Promise<void> {
    this.stopAnimation();
    const overlay = this.screenElement(this.previousSpread, this.takeOutgoingChrome());
    this.mount.append(overlay);
    this.overlay = overlay;
    this.releaseHold();
    this.updateVisibility();
    const finished = this.finished();
    this.motion = animate(
      overlay,
      { opacity: [1, 0] },
      { duration: 0.2, ease: "easeOut", onComplete: () => this.stopAnimation() },
    );
    await finished;
  }

  /**
   * Draws a turn on a canvas from two page rasters. `progress` 0 shows the
   * outgoing page, 1 the incoming page; curl instead follows a touch point
   * on its geometry. A drag maps the finger to either, and on release the
   * turn runs to the end or back to the start at Legado's speed.
   */
  private async presentCanvas(
    effect: CanvasEffect,
    forward: boolean,
    aim: Point | null,
    drag: Drag | null,
  ): Promise<void> {
    this.stopAnimation();
    const rect = this.host.getBoundingClientRect();
    const width = rect.width || this.host.clientWidth;
    const height = rect.height || this.host.clientHeight;
    if (width <= 0 || height <= 0) {
      this.releaseHold();
      return;
    }
    const ratio = this.host.ownerDocument.defaultView?.devicePixelRatio || 1;
    const outgoing = this.rasterize(this.previousSpread, this.takeOutgoingChrome(), rect, ratio);
    const incoming = this.rasterize(this.currentSpread, this.captureChrome(), rect, ratio);
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

    // Curl lifts the corner nearest the touch; drags from the middle third
    // stay level with an edge (Legado SimulationPageDelegate).
    const origin = drag?.start ?? aim;
    const top = forward && origin !== null && origin.y < height / 2;
    const corner = { x: width, y: top ? 0 : height };
    const level = (y: number) => {
      if (!forward) return height;
      if (origin && origin.y > height / 3 && origin.y < height / 2) return 0.1;
      if (origin && origin.y >= height / 2 && origin.y < (height * 2) / 3) return height;
      return y;
    };
    const flat = { x: width - 1, y: corner.y };
    const away = { x: -width, y: corner.y };
    const lifted = {
      x: Math.min(width - 1, aim?.x ?? width * 0.9),
      y: level(aim?.y ?? (top ? height * 0.05 : height * 0.9)),
    };
    // Touch points for curl at the start and end of a programmatic turn.
    const curlFrom = forward ? lifted : away;
    const curlTo = forward ? away : flat;
    const frame = forward
      ? { current: outgoing.canvas, next: incoming.canvas }
      : { current: incoming.canvas, next: outgoing.canvas };

    /** Fraction of the turn completed by a finger at `point`. */
    const dragProgress = (point: Point) => {
      const start = drag?.start ?? point;
      const moved = forward ? start.x - point.x : point.x - start.x;
      return Math.min(1, Math.max(0, moved / width));
    };
    const curlTouch = (progress: number) => ({
      x: curlFrom.x + (curlTo.x - curlFrom.x) * progress,
      y: curlFrom.y + (curlTo.y - curlFrom.y) * progress,
    });
    /** Curl touch point under the finger during a drag. */
    const fingerTouch = (point: Point) =>
      forward
        ? { x: Math.min(width - 1, point.x), y: level(point.y) }
        : curlTouch(dragProgress(point));

    const draw = (progress: number, touch?: Point) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (effect === "curl") {
        drawCurl(
          context,
          { ...frame, background: outgoing.background, width, height },
          curlGeometry(touch ?? curlTouch(progress), corner, width),
        );
      } else {
        drawShift(
          context,
          effect,
          forward,
          progress,
          outgoing.canvas,
          incoming.canvas,
          width,
          height,
        );
      }
      // The canvas now shows the outgoing page; the held copy can go.
      this.releaseHold();
    };

    const finished = this.finished();
    const duration = Math.max(1, this.options.turnDuration ?? 300);
    const run = (
      from: number,
      to: number,
      fromTouch?: Point,
      toTouch?: Point,
      done?: () => void,
    ) => {
      const started = this.now();
      const span = Math.max(80, duration * Math.abs(to - from));
      const step = (time: number) => {
        if (this.overlay !== canvas) return;
        const linear = Math.min(1, (time - started) / span);
        // Programmatic turns decelerate; releasing a drag continues linearly.
        const eased = drag ? linear : 1 - (1 - linear) ** 3;
        const progress = from + (to - from) * eased;
        const touch =
          fromTouch && toTouch
            ? {
                x: fromTouch.x + (toTouch.x - fromTouch.x) * eased,
                y: fromTouch.y + (toTouch.y - fromTouch.y) * eased,
              }
            : undefined;
        draw(progress, touch);
        if (linear >= 1) {
          done?.();
          this.stopAnimation();
        } else this.frame = this.requestFrame(step);
      };
      step(started);
    };

    if (!drag) {
      run(0, 1);
      await finished;
      return;
    }
    const settle = () => {
      const commit = drag.release === true;
      const from = dragProgress(drag.point);
      const to = commit ? 1 : 0;
      const target = effect === "curl" ? (commit ? curlTo : forward ? flat : away) : undefined;
      run(from, to, effect === "curl" ? fingerTouch(drag.point) : undefined, target, () => {
        if (!commit) this.cancelled = true;
      });
    };
    drag.wake = () => {
      if (this.overlay !== canvas) return;
      if (drag.release !== null) {
        drag.wake = null;
        settle();
        return;
      }
      draw(dragProgress(drag.point), effect === "curl" ? fingerTouch(drag.point) : undefined);
    };
    drag.wake();
    await finished;
  }

  private rasterize(
    pages: readonly ReaderDisplayedPage[],
    chrome: HTMLElement[],
    rect: DOMRect,
    ratio: number,
  ): { canvas: HTMLCanvasElement; background: string } {
    const element = this.screenElement(pages, chrome);
    element.style.visibility = "hidden";
    this.mount.append(element);
    try {
      const background =
        element.ownerDocument.defaultView?.getComputedStyle(element).backgroundColor || "#ffffff";
      return {
        canvas: rasterizePage(element, rect, ratio, this.options.backgroundImage?.()),
        background,
      };
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
    this.mount.style.visibility = this.held || this.overlay || this.reveal ? "visible" : "hidden";
  }

  private takeOutgoingChrome(): HTMLElement[] {
    const chrome = this.outgoingChrome ?? this.captureChrome();
    this.outgoingChrome = null;
    return chrome;
  }

  /** Copies of the header and footer (`data-reader-chrome`) at their screen positions. */
  private captureChrome(): HTMLElement[] {
    const parent = this.host.parentElement;
    if (!parent) return [];
    const origin = this.host.getBoundingClientRect();
    return Array.from(parent.querySelectorAll<HTMLElement>(":scope > [data-reader-chrome]")).map(
      (bar) => {
        const rect = bar.getBoundingClientRect();
        const copy = bar.cloneNode(true) as HTMLElement;
        copy.removeAttribute("data-reader-chrome");
        copy.removeAttribute("data-testid");
        Object.assign(copy.style, {
          position: "absolute",
          left: `${rect.left - origin.left}px`,
          top: `${rect.top - origin.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          margin: "0",
        });
        return copy;
      },
    );
  }

  /** A copy of the whole reading screen: background, bars, and pages in place. */
  private screenElement(pages: readonly ReaderDisplayedPage[], chrome: HTMLElement[]): HTMLElement {
    const box = this.options.pageBox?.();
    const spread = this.spreadElement(pages);
    if (!box) return spread;
    const screen = this.mount.ownerDocument.createElement("div");
    screen.className = this.options.screenClassName ?? "";
    Object.assign(screen.style, { position: "absolute", inset: "0" });
    const origin = this.host.getBoundingClientRect();
    const frame = box.getBoundingClientRect();
    Object.assign(spread.style, {
      inset: "auto",
      left: `${frame.left - origin.left}px`,
      top: `${frame.top - origin.top}px`,
      width: `${frame.width}px`,
      height: `${frame.height}px`,
    });
    screen.append(...chrome.map((bar) => bar.cloneNode(true) as HTMLElement), spread);
    return screen;
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
    renderReaderText(element, page.text, {
      continued: page.continued,
      headings: this.headings.local(page.startOffset, page.endOffset),
    });
    element.style.pointerEvents = "none";
    return element;
  }
}

/**
 * Slide moves both pages together; cover moves only the upper page with a
 * shadow on its trailing edge (Legado SlidePageDelegate, CoverPageDelegate).
 */
function drawShift(
  context: CanvasRenderingContext2D,
  effect: "slide" | "cover",
  forward: boolean,
  progress: number,
  outgoing: CanvasImageSource,
  incoming: CanvasImageSource,
  width: number,
  height: number,
) {
  const offset = progress * width;
  if (effect === "slide") {
    const outgoingX = forward ? -offset : offset;
    context.drawImage(outgoing, outgoingX, 0, width, height);
    context.drawImage(incoming, forward ? outgoingX + width : outgoingX - width, 0, width, height);
    return;
  }
  // Cover: forward slides the outgoing page off the incoming one; backward
  // slides the incoming page in over the outgoing one.
  const [below, above, aboveX] = forward
    ? [incoming, outgoing, -offset]
    : [outgoing, incoming, offset - width];
  context.drawImage(below, 0, 0, width, height);
  context.drawImage(above, aboveX, 0, width, height);
  const edge = aboveX + width;
  if (edge > 0 && edge < width) {
    const shadow = context.createLinearGradient(edge, 0, edge + 30, 0);
    shadow.addColorStop(0, "rgba(17,17,17,0.4)");
    shadow.addColorStop(1, "rgba(17,17,17,0)");
    context.fillStyle = shadow;
    context.fillRect(edge, 0, 30, height);
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

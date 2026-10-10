/**
 * Page gestures after Legado 3.26.7 (`ReadView.onTouchEvent`,
 * `HorizontalPageDelegate`): a press that stays within the touch slop is a
 * tap resolved through the nine tap zones; moving past the slop fixes a turn
 * direction once and the page follows the finger; on release the turn
 * completes unless the last movement went back. Holding still starts native
 * text selection instead of a gesture.
 */

export type TapAction =
  | "none"
  | "menu"
  | "next"
  | "previous"
  | "next-chapter"
  | "previous-chapter"
  | "contents"
  | "search"
  | "bookmark";

/** Row-major 3×3 grid: top-left, top-centre, …, bottom-right. */
export type TapZones = readonly [
  TapAction,
  TapAction,
  TapAction,
  TapAction,
  TapAction,
  TapAction,
  TapAction,
  TapAction,
  TapAction,
];

/** Legado's defaults (`AppConfig.clickAction*`): left column and top band go back. */
export const DEFAULT_TAP_ZONES: TapZones = [
  "previous",
  "previous",
  "next",
  "previous",
  "menu",
  "next",
  "previous",
  "next",
  "next",
];

export interface Point {
  x: number;
  y: number;
}

export type TurnDirection = "next" | "previous";

export interface GestureHandlers {
  tap(action: TapAction, point: Point): void;
  /** A drag fixed its direction; return false when there is no page that way. */
  dragStart(direction: TurnDirection, start: Point): boolean;
  dragMove(point: Point): void;
  /** `commit` is false when the final movement went back toward the start. */
  dragEnd(commit: boolean, point: Point): void;
}

export interface GestureOptions {
  /** Movement in CSS px before a press becomes a drag. */
  slop?: number;
  /** Holding longer than this without moving leaves the touch to text selection. */
  longPress?: number;
  zones?: TapZones;
  /** Continuous scrolling: vertical drags belong to the scroller, taps still act. */
  scroll?: boolean;
  now?: () => number;
}

type State =
  | { kind: "idle" }
  | { kind: "pressed"; start: Point; at: number }
  | { kind: "dragging"; last: Point; direction: TurnDirection; backward: boolean }
  | { kind: "ignored" };

export function tapZone(point: Point, width: number, height: number, zones: TapZones): TapAction {
  const column = point.x < width * 0.33 ? 0 : point.x < width * 0.66 ? 1 : 2;
  const row = point.y < height * 0.33 ? 0 : point.y < height * 0.66 ? 1 : 2;
  return zones[row * 3 + column];
}

export class PageGestureTracker {
  private state: State = { kind: "idle" };
  private readonly slop: number;
  private readonly longPress: number;
  private readonly now: () => number;

  public constructor(
    private readonly handlers: GestureHandlers,
    private options: GestureOptions = {},
  ) {
    this.slop = options.slop ?? 10;
    this.longPress = options.longPress ?? 500;
    this.now = options.now ?? (() => Date.now());
  }

  public configure(options: Pick<GestureOptions, "zones" | "scroll">): void {
    this.options = { ...this.options, ...options };
  }

  /** True while a page drag owns the touch, so native scrolling and selection must be prevented. */
  public get dragging(): boolean {
    return this.state.kind === "dragging";
  }

  public down(point: Point): void {
    this.state = { kind: "pressed", start: point, at: this.now() };
  }

  public move(point: Point): void {
    const state = this.state;
    if (state.kind === "pressed") {
      const dx = point.x - state.start.x;
      const dy = point.y - state.start.y;
      if (Math.hypot(dx, dy) <= this.slop) return;
      // A held press became text selection before it moved.
      if (this.now() - state.at > this.longPress) {
        this.state = { kind: "ignored" };
        return;
      }
      if (this.options.scroll || Math.abs(dy) > Math.abs(dx)) {
        this.state = { kind: "ignored" };
        return;
      }
      const direction: TurnDirection = dx < 0 ? "next" : "previous";
      if (!this.handlers.dragStart(direction, state.start)) {
        this.state = { kind: "ignored" };
        return;
      }
      this.state = { kind: "dragging", last: point, direction, backward: false };
      this.handlers.dragMove(point);
      return;
    }
    if (state.kind === "dragging") {
      if (point.x !== state.last.x) {
        // Legado: the turn cancels when the latest step moves back.
        state.backward =
          state.direction === "next" ? point.x > state.last.x : point.x < state.last.x;
      }
      state.last = point;
      this.handlers.dragMove(point);
    }
  }

  public up(point: Point, width: number, height: number, selecting: boolean): void {
    const state = this.state;
    this.state = { kind: "idle" };
    if (state.kind === "dragging") {
      this.handlers.dragEnd(!state.backward, point);
      return;
    }
    if (state.kind !== "pressed" || selecting) return;
    if (this.now() - state.at > this.longPress) return;
    this.handlers.tap(
      tapZone(state.start, width, height, this.options.zones ?? DEFAULT_TAP_ZONES),
      state.start,
    );
  }

  /** The platform took the touch (for example a system gesture). */
  public cancel(): void {
    const state = this.state;
    this.state = { kind: "idle" };
    if (state.kind === "dragging") this.handlers.dragEnd(false, state.last);
  }
}

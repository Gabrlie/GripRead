import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Movement before a drag counts as vertical or horizontal. */
const SLOP = 10;
/** A sideways drag past this share of the width switches. */
const SWITCH_SHARE = 0.25;
/** Or a shorter flick at least this fast (px/ms). */
const FLICK_SPEED = 0.45;
/** How far the content follows the finger where there is nothing to switch to. */
const EDGE_FOLLOW = 0.25;
/** Each half of a switch: the old page out, the new one in. */
export const SLIDE_MS = 200;

export interface PagerState {
  /** How far the content is moved sideways, in pixels. */
  offset: number;
  /** Whether the content moves to `offset` with a transition. */
  animate: boolean;
}

/**
 * Switching pages (shelf groups) by swiping sideways on `target`, like a
 * pager: the content follows the finger, and on release slides out, the
 * page changes (`onSwitch`), and the new one slides in from the other side.
 * `slide` runs the same for a tab tap. Vertical drags stay scrolls, and
 * touches inside `[data-no-swipe]` are left alone.
 */
export function useSwipePages(
  target: RefObject<HTMLElement | null>,
  onSwitch: (step: 1 | -1) => void,
  can: (step: 1 | -1) => boolean,
  enabled = true,
) {
  const [state, setState] = useState<PagerState>({ offset: 0, animate: false });
  const handlers = useRef({ onSwitch, can });
  handlers.current = { onSwitch, can };
  const timers = useRef<number[]>([]);

  const width = () => target.current?.clientWidth || window.innerWidth;
  const clear = () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
  };
  /**
   * Out to the side, switch, in from the other side. `change` replaces the
   * switch to the neighbouring page (a tab tap may jump further).
   */
  const slide = useCallback((step: 1 | -1, change?: () => void) => {
    clear();
    const distance = width();
    setState({ offset: -step * distance, animate: true });
    timers.current.push(
      window.setTimeout(() => {
        if (change) change();
        else handlers.current.onSwitch(step);
        setState({ offset: step * distance, animate: false });
        // Placed off to the side first, then moved in with a transition.
        timers.current.push(window.setTimeout(() => setState({ offset: 0, animate: true }), 20));
      }, SLIDE_MS),
    );
  }, []);
  useEffect(() => clear, []);

  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return;
    let start: { x: number; y: number; time: number } | null = null;
    let axis: "x" | "y" | null = null;
    let dx = 0;
    const down = (event: TouchEvent) => {
      const touch = event.touches[0];
      const inside = (event.target as Element | null)?.closest?.("[data-no-swipe]");
      start =
        event.touches.length === 1 && !inside
          ? { x: touch.clientX, y: touch.clientY, time: event.timeStamp }
          : null;
      axis = null;
      dx = 0;
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return;
        axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
        if (axis === "y") {
          start = null;
          return;
        }
        clear();
      }
      // A sideways drag does not also scroll the page.
      if (event.cancelable) event.preventDefault();
      const step = dx < 0 ? 1 : -1;
      setState({
        offset: handlers.current.can(step) ? dx : dx * EDGE_FOLLOW,
        animate: false,
      });
    };
    const up = (event: TouchEvent) => {
      if (!start || axis !== "x") {
        start = null;
        return;
      }
      const speed = Math.abs(dx) / Math.max(1, event.timeStamp - start.time);
      start = null;
      const step = dx < 0 ? 1 : -1;
      const far =
        Math.abs(dx) >= width() * SWITCH_SHARE || (Math.abs(dx) >= 24 && speed >= FLICK_SPEED);
      if (far && handlers.current.can(step)) slide(step);
      else setState({ offset: 0, animate: true });
    };
    element.addEventListener("touchstart", down, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", up);
    element.addEventListener("touchcancel", up);
    return () => {
      element.removeEventListener("touchstart", down);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", up);
      element.removeEventListener("touchcancel", up);
    };
  }, [target, enabled, slide]);
  return { ...state, slide };
}

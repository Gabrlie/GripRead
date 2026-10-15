import { useEffect, useRef, useState, type RefObject } from "react";

/** Movement before a drag counts as vertical or horizontal. */
const SLOP = 10;
/** A sideways drag at least this long switches. */
const SWITCH_DISTANCE = 72;
/** Or a shorter flick at least this fast (px/ms). */
const FLICK_SPEED = 0.45;
/** How much of the finger's travel the content follows. */
const FOLLOW = 0.35;

export interface SwipeState {
  /** How far the content follows the finger sideways, in pixels. */
  offset: number;
  dragging: boolean;
}

/**
 * Switching pages (shelf groups) by swiping sideways on `target`: the content
 * follows the finger a little, and a long enough drag or a flick calls
 * `onSwipe` with `1` for the next page (swiping left) or `-1` for the
 * previous one. Vertical drags stay scrolls; at either end the content only
 * gives a little.
 */
export function useSwipePages(
  target: RefObject<HTMLElement | null>,
  onSwipe: (step: 1 | -1) => void,
  can: (step: 1 | -1) => boolean,
  enabled = true,
): SwipeState {
  const [state, setState] = useState<SwipeState>({ offset: 0, dragging: false });
  const handlers = useRef({ onSwipe, can });
  handlers.current = { onSwipe, can };
  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return;
    let start: { x: number; y: number; time: number } | null = null;
    let axis: "x" | "y" | null = null;
    let dx = 0;
    const down = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        event.touches.length === 1
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
      }
      const step = dx < 0 ? 1 : -1;
      const follow = handlers.current.can(step) ? FOLLOW : FOLLOW / 3;
      setState({ offset: dx * follow, dragging: true });
    };
    const up = (event: TouchEvent) => {
      if (!start || axis !== "x") {
        start = null;
        return;
      }
      const speed = Math.abs(dx) / Math.max(1, event.timeStamp - start.time);
      start = null;
      setState({ offset: 0, dragging: false });
      const step = dx < 0 ? 1 : -1;
      const far = Math.abs(dx) >= SWITCH_DISTANCE || (Math.abs(dx) >= 24 && speed >= FLICK_SPEED);
      if (far && handlers.current.can(step)) handlers.current.onSwipe(step);
    };
    element.addEventListener("touchstart", down, { passive: true });
    element.addEventListener("touchmove", move, { passive: true });
    element.addEventListener("touchend", up);
    element.addEventListener("touchcancel", up);
    return () => {
      element.removeEventListener("touchstart", down);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", up);
      element.removeEventListener("touchcancel", up);
    };
  }, [target, enabled]);
  return state;
}

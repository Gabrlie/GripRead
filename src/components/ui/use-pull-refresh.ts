import { useEffect, useRef, useState, type RefObject } from "react";

/** The pull distance that refreshes on release. */
export const PULL_TRIGGER = 60;
/** The pull distance a long drag approaches but never reaches. */
const PULL_MAX = 96;
/** How quickly the pull stiffens: a drag of this length covers ~63% of the maximum. */
const PULL_STIFFNESS = 120;
/** Movement before a drag counts as vertical or horizontal. */
const SLOP = 8;

/** Rubber-band damping: follows the finger at first, then stiffens. */
export function pullDistance(travel: number): number {
  if (travel <= 0) return 0;
  return PULL_MAX * (1 - Math.exp(-travel / PULL_STIFFNESS));
}

export interface PullState {
  /** How far the content is pulled down, in pixels. */
  distance: number;
  /** A finger is pulling; without one the distance animates back. */
  dragging: boolean;
}

/**
 * 下拉刷新 for a page that scrolls with the window: a downward drag that
 * starts on `target` while the page is at its top pulls the content, and
 * releasing past {@link PULL_TRIGGER} calls `onRefresh`. A drag that turns
 * out sideways is left to other gestures.
 */
export function usePullRefresh(
  target: RefObject<HTMLElement | null>,
  onRefresh: () => void,
  enabled = true,
): PullState {
  const [state, setState] = useState<PullState>({ distance: 0, dragging: false });
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return;
    let start: { x: number; y: number } | null = null;
    let axis: "x" | "y" | null = null;
    let distance = 0;
    const update = (value: number, dragging: boolean) => {
      distance = value;
      setState({ distance: value, dragging });
    };
    const down = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        window.scrollY <= 0 && event.touches.length === 1
          ? { x: touch.clientX, y: touch.clientY }
          : null;
      axis = null;
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return;
        axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
      }
      if (axis === "x") {
        start = null;
        if (distance) update(0, false);
        return;
      }
      if (dy <= 0 || window.scrollY > 0) {
        // Back above where it started: an ordinary scroll from here on.
        start = null;
        if (distance) update(0, false);
        return;
      }
      // While pulling, the page itself does not scroll, so moving back up
      // shrinks the pull instead of scrolling under it.
      if (event.cancelable) event.preventDefault();
      update(pullDistance(dy - SLOP), true);
    };
    const up = () => {
      if (!start) return;
      start = null;
      const pulled = distance;
      if (pulled > 0) update(0, false);
      if (pulled >= PULL_TRIGGER) refresh.current();
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
  }, [target, enabled]);
  return state;
}

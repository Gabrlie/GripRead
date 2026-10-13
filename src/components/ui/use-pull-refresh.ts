import { useEffect, useRef, useState, type RefObject } from "react";

/** How far the finger travels for each pixel the indicator moves. */
const RESISTANCE = 0.5;
/** The indicator distance that refreshes on release. */
export const PULL_TRIGGER = 56;
const PULL_MAX = 88;

/**
 * 下拉刷新 for a page that scrolls with the window: a downward drag that
 * starts on `target` while the page is at its top pulls an indicator, and
 * releasing past {@link PULL_TRIGGER} calls `onRefresh`. Returns how far the
 * indicator is pulled.
 */
export function usePullRefresh(
  target: RefObject<HTMLElement | null>,
  onRefresh: () => void,
  enabled = true,
): number {
  const [pull, setPull] = useState(0);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return;
    let start: number | null = null;
    let distance = 0;
    const update = (value: number) => {
      distance = value;
      setPull(value);
    };
    const down = (event: TouchEvent) => {
      start = window.scrollY <= 0 && event.touches.length === 1 ? event.touches[0].clientY : null;
      update(0);
    };
    const move = (event: TouchEvent) => {
      if (start === null) return;
      const travel = event.touches[0].clientY - start;
      if (travel <= 0 || window.scrollY > 0) {
        update(0);
        return;
      }
      update(Math.min(PULL_MAX, travel * RESISTANCE));
    };
    const up = () => {
      if (start === null) return;
      start = null;
      const pulled = distance;
      update(0);
      if (pulled >= PULL_TRIGGER) refresh.current();
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
  return pull;
}

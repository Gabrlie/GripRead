import { useCallback, useRef, useState, type PointerEvent } from "react";

export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

const NONE: Zoom = { scale: 1, x: 0, y: 0 };
const MAX_SCALE = 4;
const DOUBLE_TAP_MS = 280;
const TAP_SLOP = 10;
const SWIPE = 60;

export interface ZoomGestures {
  /** A tap that was not part of a double tap, at its point in the element. */
  onTap: (x: number, y: number, width: number, height: number) => void;
  /** A horizontal swipe while not zoomed: -1 to the left, 1 to the right. */
  onSwipe?: (direction: -1 | 1) => void;
}

/**
 * Pinch and double-tap zoom with panning while zoomed, plus taps and
 * swipes, from pointer events. A single tap waits for a possible second
 * one, so it reaches `onTap` slightly late. A cancelled pointer (the
 * browser scrolling instead) is never a tap.
 */
export function useZoom(gestures: ZoomGestures) {
  const [zoom, setZoom] = useState<Zoom>(NONE);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const gesturesRef = useRef(gestures);
  gesturesRef.current = gestures;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{
    x: number;
    y: number;
    time: number;
    moved: boolean;
    multi: boolean;
  } | null>(null);
  const pinch = useRef<{ distance: number; zoom: Zoom; cx: number; cy: number } | null>(null);
  const pan = useRef<{ x: number; y: number; zoom: Zoom } | null>(null);
  const lastTap = useRef<{ time: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  const reset = useCallback(() => setZoom(NONE), []);

  const distance = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      start.current = {
        x: event.clientX,
        y: event.clientY,
        time: Date.now(),
        moved: false,
        multi: false,
      };
      pan.current = { x: event.clientX, y: event.clientY, zoom: zoomRef.current };
    } else if (pointers.current.size === 2) {
      if (start.current) start.current.multi = true;
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        distance: distance(),
        zoom: zoomRef.current,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const begun = start.current;
    if (begun && Math.hypot(event.clientX - begun.x, event.clientY - begun.y) > TAP_SLOP)
      begun.moved = true;
    if (pinch.current && pointers.current.size === 2) {
      const ratio = distance() / (pinch.current.distance || 1);
      const scale = Math.min(MAX_SCALE, Math.max(1, pinch.current.zoom.scale * ratio));
      setZoom(scale === 1 ? NONE : { ...pinch.current.zoom, scale });
    } else if (pan.current && zoomRef.current.scale > 1 && pointers.current.size === 1) {
      setZoom({
        scale: zoomRef.current.scale,
        x: pan.current.zoom.x + event.clientX - pan.current.x,
        y: pan.current.zoom.y + event.clientY - pan.current.y,
      });
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size > 0) return;
    pinch.current = null;
    pan.current = null;
    const begun = start.current;
    start.current = null;
    if (!begun || begun.multi) return;
    const dx = event.clientX - begun.x;
    const dy = event.clientY - begun.y;
    if (begun.moved) {
      if (zoomRef.current.scale <= 1 && Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5)
        gesturesRef.current.onSwipe?.(dx < 0 ? -1 : 1);
      return;
    }
    const target = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - target.left;
    const y = event.clientY - target.top;
    const previous = lastTap.current;
    if (previous && Date.now() - previous.time < DOUBLE_TAP_MS) {
      clearTimeout(previous.timer);
      lastTap.current = null;
      // Double tap: zoom in around the point, or back out.
      if (zoomRef.current.scale > 1) setZoom(NONE);
      else {
        const scale = 2.5;
        setZoom({
          scale,
          x: (target.width / 2 - x) * (scale - 1),
          y: (target.height / 2 - y) * (scale - 1),
        });
      }
      return;
    }
    const timer = setTimeout(() => {
      lastTap.current = null;
      gesturesRef.current.onTap(x, y, target.width, target.height);
    }, DOUBLE_TAP_MS);
    lastTap.current = { time: Date.now(), timer };
  };

  // The browser took the touch over (a scroll began): it ends without a tap.
  const onPointerCancel = (event: PointerEvent<HTMLElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size > 0) return;
    pinch.current = null;
    pan.current = null;
    start.current = null;
  };

  /** Whether a finger (or button) is down. */
  const pressed = useCallback(() => pointers.current.size > 0, []);

  return {
    zoom,
    reset,
    pressed,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
  };
}

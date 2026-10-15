import { useRef, type MouseEvent, type PointerEvent } from "react";

/**
 * Long-press (or right-click) runs `onLongPress`, as Legado's long-press menus do;
 * the click that ends a long press does not also open the book.
 */
export function useLongPress(onLongPress: () => void, onClick: () => void) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  // A finger that moves (scrolling, swiping) is not pressing.
  const origin = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (event: PointerEvent) => {
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, 550);
    },
    onPointerMove: (event: PointerEvent) => {
      const start = origin.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      clear();
      if (!fired.current) onLongPress();
      fired.current = true;
    },
    onClick: () => {
      if (fired.current) {
        fired.current = false;
        return;
      }
      onClick();
    },
  };
}

import { useRef, type MouseEvent } from "react";

/**
 * Long-press (or right-click) runs `onLongPress`, as Legado's long-press menus do;
 * the click that ends a long press does not also open the book.
 */
export function useLongPress(onLongPress: () => void, onClick: () => void) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: () => {
      fired.current = false;
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, 550);
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

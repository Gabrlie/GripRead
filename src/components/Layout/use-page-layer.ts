import { useEffect, useRef } from "react";

const OPEN_LAYER =
  '[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"][data-open]';

/**
 * Full-screen pages over the shelf mark themselves as open layers, so the
 * Android back gesture (dispatched as Escape) closes them; a dialog opened
 * on top of the page closes first.
 */
/** Full-screen pages open now. */
const open = { count: 0 };

export function usePageLayer(onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const layers = [...document.querySelectorAll(OPEN_LAYER)];
      if (layers.at(-1) !== page.current) return;
      close.current();
    };
    window.addEventListener("keydown", handle);
    // The window behind a full-screen page does not scroll (or show its
    // scrollbar) while the page is open.
    open.count += 1;
    document.documentElement.classList.add("page-layer-open");
    return () => {
      window.removeEventListener("keydown", handle);
      open.count -= 1;
      if (open.count === 0) document.documentElement.classList.remove("page-layer-open");
    };
  }, []);
  return page;
}

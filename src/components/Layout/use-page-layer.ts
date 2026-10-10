import { useEffect, useRef } from "react";

const OPEN_LAYER =
  '[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"][data-open]';

/**
 * Full-screen pages over the shelf mark themselves as open layers, so the
 * Android back gesture (dispatched as Escape) closes them; a dialog opened
 * on top of the page closes first.
 */
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
    return () => window.removeEventListener("keydown", handle);
  }, []);
  return page;
}

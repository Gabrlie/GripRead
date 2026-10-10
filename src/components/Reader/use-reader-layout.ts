import { useLayoutEffect, type RefObject } from "react";
import type { ReaderController } from "../../reader";

/**
 * Two pages fit on wide screens and on landscape screens from 600 CSS px,
 * so phones turned sideways show spreads as Legado does.
 */
export function canShowSpread(width: number, height: number): boolean {
  return width >= 900 || (width > height && width >= 600);
}

/** Copy the page box size to the hidden measurement box. */
export function syncMeasureBox(page: HTMLElement, measure: HTMLElement, columns = 1): void {
  const rect = page.getBoundingClientRect();
  const gutter = columns === 2 ? 32 : 0;
  Object.assign(measure.style, {
    width: `${(rect.width - gutter) / columns}px`,
    height: `${rect.height}px`,
  });
}

/**
 * Coalesce every layout trigger (viewport resize, late font loading, and
 * typography changes identified by `signature`) into one reflow per frame.
 * The controller re-measures from the current text locator, never a page index.
 */
export function useReaderLayout(
  controller: ReaderController | null,
  pageBox: RefObject<HTMLElement | null>,
  measureBox: RefObject<HTMLElement | null>,
  signature: string,
  beforeReflow: () => void,
  run: (action: () => Promise<void>) => void,
  columns = 1,
): void {
  useLayoutEffect(() => {
    if (!controller || !pageBox.current || !measureBox.current) return;
    let frame = 0;
    let fallback = 0;
    let disposed = false;
    const reflow = () => {
      beforeReflow();
      cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
      let settled = false;
      const measure = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallback);
        if (disposed || !pageBox.current || !measureBox.current) return;
        syncMeasureBox(pageBox.current, measureBox.current, columns);
        run(() => controller.reflow());
      };
      frame = requestAnimationFrame(measure);
      // requestAnimationFrame is paused for hidden windows; still settle.
      fallback = window.setTimeout(measure, 100);
    };
    const observer = new ResizeObserver(reflow);
    observer.observe(pageBox.current);
    document.fonts.addEventListener("loadingdone", reflow);
    void document.fonts.ready.then(() => {
      if (!disposed) reflow();
    });
    reflow();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", reflow);
    };
  }, [beforeReflow, controller, measureBox, pageBox, run, signature, columns]);
}

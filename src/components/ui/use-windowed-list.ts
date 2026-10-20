import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";

const OVERSCAN = 12;

/**
 * Renders only the rows of a long list near the viewport. Rows have known
 * heights (`heightOf`), so the hook can place any row without measuring and
 * scroll straight to one; the rest of the list is two spacers. A list that
 * does not start at the top of its scroller names its element (`list`).
 */
export function useWindowedList(
  scroller: RefObject<HTMLElement | null>,
  count: number,
  heightOf: (index: number) => number,
  list?: RefObject<HTMLElement | null>,
) {
  const offsets = useMemo(() => {
    const list = new Array<number>(count + 1);
    list[0] = 0;
    for (let index = 0; index < count; index++) list[index + 1] = list[index] + heightOf(index);
    return list;
  }, [count, heightOf]);
  const [view, setView] = useState({ top: 0, height: 800 });

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const start = list?.current
          ? list.current.getBoundingClientRect().top -
            box.getBoundingClientRect().top +
            box.scrollTop
          : 0;
        setView({ top: box.scrollTop - start, height: box.clientHeight || 800 });
      });
    };
    update();
    box.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(box);
    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [scroller, list]);

  const find = (offset: number) => {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle + 1] <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const start = Math.max(0, find(view.top) - OVERSCAN);
  const end = Math.min(count, find(view.top + view.height) + 1 + OVERSCAN);

  const scrollToIndex = useCallback(
    (index: number, align: "center" | "start" = "center") => {
      const box = scroller.current;
      if (!box || index < 0 || index >= count) return;
      const top =
        align === "center"
          ? offsets[index] - (box.clientHeight - heightOf(index)) / 2
          : offsets[index];
      box.scrollTop = Math.max(0, top);
      setView({ top: box.scrollTop, height: box.clientHeight || 800 });
    },
    [scroller, count, offsets, heightOf],
  );

  return {
    start,
    end,
    /** The first row in view: those before it have scrolled past. */
    first: view.top > 0 ? find(view.top) : 0,
    before: offsets[start] ?? 0,
    after: (offsets[count] ?? 0) - (offsets[end] ?? 0),
    scrollToIndex,
  };
}

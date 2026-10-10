import type { ContentWindow, TocEntry } from "../types/generated";

export interface ReaderChapter {
  title: string;
  start: number;
  end: number;
}

/** The TOC supplies headings; all reading modes use these same body ranges. */
export function chapterRanges(
  entries: readonly TocEntry[],
  window: ContentWindow,
): ReaderChapter[] {
  if (!window.totalLength) return [];
  const starts = entries
    .filter(
      ({ locator }) =>
        locator.bookId === window.bookId &&
        locator.contentVersion === window.contentVersion &&
        locator.resourceId === window.resourceId &&
        locator.offset >= 0 &&
        locator.offset < window.totalLength,
    )
    .sort((a, b) => a.locator.offset - b.locator.offset);
  const unique = starts.filter(
    (entry, index) => index === 0 || entry.locator.offset !== starts[index - 1].locator.offset,
  );
  const ranges = unique.map((entry, index) => ({
    title: entry.title,
    start: entry.locator.offset,
    end: unique[index + 1]?.locator.offset ?? window.totalLength,
  }));
  if (!ranges.length) return [{ title: "全文", start: 0, end: window.totalLength }];
  if (ranges[0].start > 0) ranges.unshift({ title: "序言", start: 0, end: ranges[0].start });
  return ranges;
}

export function chapterAt(ranges: readonly ReaderChapter[], offset: number): ReaderChapter | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].start > offset) high = middle - 1;
    else low = middle + 1;
  }
  return ranges[Math.max(0, high)] ?? null;
}

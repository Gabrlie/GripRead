import { useLayoutEffect, useRef } from "react";
import { alignPageBottom, renderReaderText } from "../../reader";
import type { HeadingIndex, ReaderDisplayedPage } from "../../reader";

interface ReaderPageTextProps {
  page: ReaderDisplayedPage;
  bookId: string | null;
  /** Absolute UTF-16 range to highlight. */
  highlight: { start: number; end: number } | null;
  headings: HeadingIndex;
  /** The typography in effect; a change aligns the page again. */
  layout?: string;
}

/** Renders a measured page with the same paragraph renderer used for measurement. */
export function ReaderPageText({ page, bookId, highlight, headings, layout }: ReaderPageTextProps) {
  const content = useRef<HTMLDivElement>(null);
  // A match may cross a page boundary; clip it to the visible slice so each
  // page shows the part it contains.
  const overlaps =
    highlight !== null && highlight.end > page.startOffset && highlight.start < page.endOffset;
  const highlightStart = overlaps ? Math.max(0, highlight.start - page.startOffset) : null;
  const highlightEnd = overlaps
    ? Math.min(page.text.length, highlight.end - page.startOffset)
    : null;
  useLayoutEffect(() => {
    if (!content.current) return;
    renderReaderText(content.current, page.text, {
      continued: page.continued,
      headings: headings.local(page.startOffset, page.endOffset),
      highlight:
        highlightStart === null || highlightEnd === null
          ? null
          : { start: highlightStart, end: highlightEnd },
    });
    alignPageBottom(content.current);
    // Page-turn copies of this page take its fill instead of measuring.
    content.current.dataset.aligned = "true";
  }, [
    layout,
    page.text,
    page.continued,
    page.startOffset,
    page.endOffset,
    headings,
    highlightStart,
    highlightEnd,
  ]);
  return (
    <div
      ref={content}
      className="reader-prose reader-text h-full"
      data-testid="reader-page"
      data-book-id={bookId ?? undefined}
      data-start={page.startOffset}
      data-end={page.endOffset}
      data-total={page.totalLength}
    />
  );
}

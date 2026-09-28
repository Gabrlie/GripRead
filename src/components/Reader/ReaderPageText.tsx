import { useLayoutEffect, useRef } from "react";
import { renderReaderText } from "../../reader";
import type { ReaderDisplayedPage } from "../../reader";

interface ReaderPageTextProps {
  page: ReaderDisplayedPage;
  bookId: string | null;
  /** Absolute UTF-16 range to highlight. */
  highlight: { start: number; end: number } | null;
}

/** Renders a measured page with the same paragraph renderer used for measurement. */
export function ReaderPageText({ page, bookId, highlight }: ReaderPageTextProps) {
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
      highlight:
        highlightStart === null || highlightEnd === null
          ? null
          : { start: highlightStart, end: highlightEnd },
    });
  }, [page.text, page.continued, highlightStart, highlightEnd]);
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

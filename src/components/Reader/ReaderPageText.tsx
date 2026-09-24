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
  const localHighlight =
    highlight && highlight.end > page.startOffset && highlight.start < page.endOffset
      ? { start: highlight.start - page.startOffset, end: highlight.end - page.startOffset }
      : null;
  const highlightStart = localHighlight?.start ?? -1;
  const highlightEnd = localHighlight?.end ?? -1;
  useLayoutEffect(() => {
    if (!content.current) return;
    renderReaderText(content.current, page.text, {
      continued: page.continued,
      highlight: highlightStart < 0 ? null : { start: highlightStart, end: highlightEnd },
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

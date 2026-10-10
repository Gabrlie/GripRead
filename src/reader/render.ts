/**
 * The single DOM renderer for reader text. The visible page, the hidden
 * measurement box, and page-turn overlays all use it so paragraph spacing,
 * indentation, and text effects cannot produce different line breaks.
 *
 * Normalized TXT uses LF line endings; each line becomes a paragraph. Line
 * feeds remain in the DOM as hidden text so `textContent` still equals the
 * page's UTF-16 slice while layout is controlled by paragraph boxes.
 */
export interface RenderTextOptions {
  /** The first character continues a line that began on an earlier page. */
  continued: boolean;
  /** Highlight range relative to the rendered text. */
  highlight?: { start: number; end: number } | null;
  /** Local offsets of lines that are recognized chapter headings. */
  headings?: ReadonlySet<number>;
}

export const READER_PARAGRAPH_CLASS = "reader-paragraph";

export function renderReaderText(
  container: HTMLElement,
  text: string,
  options: RenderTextOptions,
): void {
  const document = container.ownerDocument;
  const fragment = document.createDocumentFragment();
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const first = lineStart === 0;
    const last = newline < 0;
    const continued = first && options.continued;
    if (lineEnd > lineStart) {
      const paragraph = document.createElement("p");
      paragraph.className = READER_PARAGRAPH_CLASS;
      paragraph.dataset.textStart = String(lineStart);
      if (continued) paragraph.dataset.continued = "true";
      if (!continued && options.headings?.has(lineStart)) paragraph.dataset.heading = "true";
      appendHighlighted(paragraph, text, lineStart, lineEnd, options.highlight ?? null);
      fragment.append(paragraph);
    } else if (!continued && !last) {
      // An empty line occupies one line box, matching pre-wrapped text.
      const blank = document.createElement("p");
      blank.className = READER_PARAGRAPH_CLASS;
      blank.dataset.textStart = String(lineStart);
      blank.dataset.blank = "true";
      blank.append(document.createElement("br"));
      fragment.append(blank);
    }
    if (last) break;
    const feed = document.createElement("span");
    feed.hidden = true;
    feed.textContent = "\n";
    fragment.append(feed);
    lineStart = newline + 1;
  }
  container.replaceChildren(fragment);
}

function appendHighlighted(
  paragraph: HTMLElement,
  text: string,
  start: number,
  end: number,
  highlight: { start: number; end: number } | null,
): void {
  const document = paragraph.ownerDocument;
  if (!highlight || highlight.end <= start || highlight.start >= end) {
    paragraph.append(text.slice(start, end));
    return;
  }
  const markStart = Math.max(start, highlight.start);
  const markEnd = Math.min(end, highlight.end);
  if (markStart > start) paragraph.append(text.slice(start, markStart));
  const mark = document.createElement("mark");
  mark.dataset.testid = "reader-highlight";
  mark.className = "rounded bg-primary/25 text-inherit";
  mark.textContent = text.slice(markStart, markEnd);
  paragraph.append(mark);
  if (markEnd < end) paragraph.append(text.slice(markEnd, end));
}

/** Whether the character at `offset` in `text` continues a line started earlier. */
export function continuesLine(text: string, offset: number, windowContinued: boolean): boolean {
  if (offset <= 0) return windowContinued;
  return text.charCodeAt(offset - 1) !== 0x0a;
}

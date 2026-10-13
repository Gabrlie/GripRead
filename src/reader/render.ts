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
      // Like Legado, a paragraph's own leading spaces give way to the
      // configured indent. They stay in the DOM, hidden, so offsets hold.
      let bodyStart = lineStart;
      if (!continued) {
        const leading = /^[\s\u3000]+/u.exec(text.slice(lineStart, lineEnd))?.[0].length ?? 0;
        if (leading > 0 && lineStart + leading < lineEnd) {
          const spaces = document.createElement("span");
          spaces.hidden = true;
          spaces.textContent = text.slice(lineStart, lineStart + leading);
          paragraph.append(spaces);
          bodyStart = lineStart + leading;
        }
      }
      appendHighlighted(paragraph, text, bodyStart, lineEnd, options.highlight ?? null);
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

/**
 * Legado's 底部对齐: a page that is full but for less than a line (a chapter
 * heading, which is taller than a line, often leaves most of one) spreads
 * that space over its paragraph gaps, so its last line sits at the bottom.
 * Gaps do not change line wrapping, so pages and offsets stay as measured.
 * Call it once the page is laid out; a short last page stays as it is.
 */
export function alignPageBottom(page: HTMLElement): void {
  page.style.removeProperty("--reader-fill");
  const paragraphs = Array.from(page.getElementsByClassName(READER_PARAGRAPH_CLASS)).filter(
    (paragraph) => paragraph.getBoundingClientRect().height > 0,
  );
  if (paragraphs.length < 2) return;
  const style = page.ownerDocument.defaultView?.getComputedStyle(page);
  const box = page.getBoundingClientRect();
  const bottom =
    box.top + (page.clientHeight || box.height) - (parseFloat(style?.paddingBottom ?? "") || 0);
  const last = paragraphs[paragraphs.length - 1];
  const left = bottom - last.getBoundingClientRect().bottom;
  const fontSize = parseFloat(style?.fontSize ?? "") || 16;
  const line = parseFloat(style?.lineHeight ?? "") || fontSize * 1.5;
  if (!(left > 0.5) || left > line * 1.3) return;
  const gaps = paragraphs.length - 1;
  // A heading's bottom margin absorbs part of the gap after it, so settle
  // the remainder over a few more layouts.
  let fill = left / gaps;
  for (let round = 0; round < 3; round += 1) {
    page.style.setProperty("--reader-fill", `${Math.max(0, fill)}px`);
    const rest = bottom - last.getBoundingClientRect().bottom;
    if (Math.abs(rest) <= 0.25) return;
    fill += rest / gaps;
  }
}

/** Whether the character at `offset` in `text` continues a line started earlier. */
export function continuesLine(text: string, offset: number, windowContinued: boolean): boolean {
  if (offset <= 0) return windowContinued;
  return text.charCodeAt(offset - 1) !== 0x0a;
}

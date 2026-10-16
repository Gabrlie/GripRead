/**
 * The single DOM renderer for reader text. The visible page, the hidden
 * measurement box, and page-turn overlays all use it so paragraph spacing,
 * indentation, and text effects cannot produce different line breaks.
 *
 * Normalized TXT uses LF line endings; each line becomes a paragraph. Line
 * feeds remain in the DOM as hidden text so `textContent` still equals the
 * page's UTF-16 slice while layout is controlled by paragraph boxes.
 */
import { LEADING, MARKS, TRANSLATED_MARK, imageOfLine, readerImages } from "./images";

export interface RenderTextOptions {
  /** The first character continues a line that began on an earlier page. */
  continued: boolean;
  /** Highlight range relative to the rendered text. */
  highlight?: { start: number; end: number } | null;
  /** Local offsets of lines that are recognized chapter headings. */
  headings?: ReadonlySet<number>;
  /** The continued first line is a translation (its mark is on an earlier page). */
  continuedTranslated?: boolean;
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
    const image = continued ? null : imageOfLine(text.slice(lineStart, lineEnd));
    if (image !== null) {
      fragment.append(imageParagraph(document, text.slice(lineStart, lineEnd), lineStart, image));
    } else if (lineEnd > lineStart) {
      const paragraph = document.createElement("p");
      paragraph.className = READER_PARAGRAPH_CLASS;
      paragraph.dataset.textStart = String(lineStart);
      if (continued) paragraph.dataset.continued = "true";
      if (!continued && options.headings?.has(lineStart)) paragraph.dataset.heading = "true";
      const lead = continued ? "" : (LEADING.exec(text.slice(lineStart, lineEnd))?.[0] ?? "");
      if (continued ? options.continuedTranslated : lead.includes(TRANSLATED_MARK))
        paragraph.dataset.translated = "true";
      // Like Legado, a paragraph's own leading spaces give way to the
      // configured indent. They stay in the DOM, hidden, so offsets hold.
      let bodyStart = lineStart;
      if (!continued) {
        // EPUB directory marks lead a line too, and are hidden with the spaces.
        const leading = LEADING.exec(text.slice(lineStart, lineEnd))?.[0].length ?? 0;
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

/**
 * An EPUB image line: the mark stays as hidden text so offsets hold, and the
 * image box takes its size from the image before it loads, capped by the
 * page height (`--reader-image-max`), so pages measure the same either way.
 */
function imageParagraph(
  document: Document,
  mark: string,
  lineStart: number,
  index: number,
): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.className = READER_PARAGRAPH_CLASS;
  paragraph.dataset.textStart = String(lineStart);
  paragraph.dataset.image = "true";
  const hidden = document.createElement("span");
  hidden.hidden = true;
  hidden.textContent = mark;
  paragraph.append(hidden);
  const images = readerImages();
  const size = images?.size(index);
  if (!images || !size) {
    paragraph.append(document.createElement("br"));
    return paragraph;
  }
  const image = document.createElement("img");
  image.className = "reader-image";
  image.alt = "";
  image.draggable = false;
  image.width = size.width;
  image.height = size.height;
  image.dataset.readerImage = String(index);
  const url = images.url(index);
  if (url) image.src = url;
  else images.load(index);
  paragraph.append(image);
  return paragraph;
}

/** Text with EPUB directory marks hidden, keeping them in `textContent`. */
function appendText(parent: HTMLElement, text: string): void {
  const document = parent.ownerDocument;
  let last = 0;
  for (const match of text.matchAll(MARKS)) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const hidden = document.createElement("span");
    hidden.hidden = true;
    hidden.textContent = match[0];
    parent.append(hidden);
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.append(last === 0 ? text : text.slice(last));
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
    appendText(paragraph, text.slice(start, end));
    return;
  }
  const markStart = Math.max(start, highlight.start);
  const markEnd = Math.min(end, highlight.end);
  if (markStart > start) appendText(paragraph, text.slice(start, markStart));
  const mark = document.createElement("mark");
  mark.dataset.testid = "reader-highlight";
  mark.className = "rounded bg-primary/25 text-inherit";
  appendText(mark, text.slice(markStart, markEnd));
  paragraph.append(mark);
  if (markEnd < end) appendText(paragraph, text.slice(markEnd, end));
}

/**
 * Legado's 底部对齐: a page that is full but for less than a line (a chapter
 * heading, which is taller than a line, often leaves most of one) spreads
 * that space over its paragraph gaps, so its last line sits at the bottom.
 * Gaps do not change line wrapping, so pages and offsets stay as measured.
 * Call it once the page is laid out; a short last page stays as it is.
 * It reads the layout once and returns the fill it set (`""` for none), so
 * copies of the same page can take it without laying out again.
 */
export function alignPageBottom(page: HTMLElement): string {
  page.style.removeProperty("--reader-fill");
  const paragraphs = Array.from(page.getElementsByClassName(READER_PARAGRAPH_CLASS)).filter(
    (paragraph) => paragraph.getBoundingClientRect().height > 0,
  );
  if (paragraphs.length < 2) return "";
  const view = page.ownerDocument.defaultView;
  const style = view?.getComputedStyle(page);
  const box = page.getBoundingClientRect();
  const bottom =
    box.top + (page.clientHeight || box.height) - (parseFloat(style?.paddingBottom ?? "") || 0);
  const left = bottom - paragraphs[paragraphs.length - 1].getBoundingClientRect().bottom;
  const fontSize = parseFloat(style?.fontSize ?? "") || 16;
  const line = parseFloat(style?.lineHeight ?? "") || fontSize * 1.5;
  if (!(left > 0.5) || left > line * 1.3) return "";
  // A heading's bottom margin collapses with the gap after it, so that gap
  // only grows once the fill passes the difference: each gap has such a
  // threshold (zero for ordinary ones), and the fill spreads over the gaps
  // past theirs.
  const thresholds = paragraphs.slice(0, -1).map((paragraph, index) => {
    if ((paragraph as HTMLElement).dataset.heading !== "true") return 0;
    const below = parseFloat(view?.getComputedStyle(paragraph).marginBottom ?? "") || 0;
    const above = parseFloat(view?.getComputedStyle(paragraphs[index + 1]).marginTop ?? "") || 0;
    return Math.max(0, below - above);
  });
  const fill = spreadFill(left, thresholds);
  const value = `${fill}px`;
  page.style.setProperty("--reader-fill", value);
  return value;
}

/**
 * The fill `f` with `Σ max(0, f - threshold)` equal to `left`: gaps join as
 * the fill passes their thresholds.
 */
export function spreadFill(left: number, thresholds: readonly number[]): number {
  const sorted = [...thresholds].sort((a, b) => a - b);
  let sum = 0;
  for (let count = 1; count <= sorted.length; count += 1) {
    sum += sorted[count - 1];
    const fill = (left + sum) / count;
    if (count === sorted.length || fill <= sorted[count]) return fill;
  }
  return 0;
}

/** Whether the character at `offset` in `text` continues a line started earlier. */
/**
 * Whether the line holding `offset` of `text` is a translation: its leading
 * marks include the translation mark. `before` is text ahead of `text`
 * (a window's context), for a line that began before it.
 */
export function translatedLineAt(text: string, offset: number, before = ""): boolean {
  const head = before + text.slice(0, offset);
  const start = head.lastIndexOf("\n") + 1;
  const lead = LEADING.exec(head.slice(start) + text.slice(offset, offset + 8))?.[0] ?? "";
  return lead.includes(TRANSLATED_MARK);
}

export function continuesLine(text: string, offset: number, windowContinued: boolean): boolean {
  if (offset <= 0) return windowContinued;
  return text.charCodeAt(offset - 1) !== 0x0a;
}

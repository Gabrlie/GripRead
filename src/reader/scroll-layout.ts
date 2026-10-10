import { isUtf16ScalarBoundary } from "./pagination";

/** Map a UTF-16 offset through nested highlight nodes without depending on their shape. */
function textPoint(element: Element, offset: number): { node: Text; offset: number } | null {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (offset <= node.length) return { node, offset };
    offset -= node.length;
    node = walker.nextNode() as Text | null;
  }
  return null;
}

function scalarRect(paragraph: HTMLElement, offset: number): DOMRect {
  const text = paragraph.textContent ?? "";
  const start = textPoint(paragraph, offset);
  const end = textPoint(paragraph, offset + (text.codePointAt(offset)! > 0xffff ? 2 : 1));
  if (!start || !end) return paragraph.getBoundingClientRect();
  const range = paragraph.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const rect = range.getBoundingClientRect();
  // Hidden leading spaces have no box; use their paragraph's position.
  return rect.width === 0 && rect.height === 0 ? paragraph.getBoundingClientRect() : rect;
}

export function rectAtOffset(root: HTMLElement, localOffset: number): DOMRect | null {
  const paragraphs = Array.from(root.querySelectorAll<HTMLElement>("[data-text-start]"));
  const paragraph = paragraphs
    .reverse()
    .find((item) => Number(item.dataset.textStart) <= localOffset);
  if (!paragraph) return null;
  const text = paragraph.textContent ?? "";
  let local = Math.min(
    text.length - 1,
    Math.max(0, localOffset - Number(paragraph.dataset.textStart)),
  );
  if (!isUtf16ScalarBoundary(text, local)) local--;
  return local < 0 ? paragraph.getBoundingClientRect() : scalarRect(paragraph, local);
}

/** First/last visible scalar boundaries, using paragraph and line binary searches. */
export function visibleOffsets(
  root: HTMLElement,
  viewport: HTMLElement,
): { start: number; end: number } {
  const paragraphs = Array.from(root.querySelectorAll<HTMLElement>("[data-text-start]"));
  if (!paragraphs.length) return { start: 0, end: root.textContent?.length ?? 0 };
  const box = viewport.getBoundingClientRect();
  const boundary = (y: number, end: boolean) => {
    let low = 0;
    let high = paragraphs.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (paragraphs[mid].getBoundingClientRect().bottom <= y) low = mid + 1;
      else high = mid;
    }
    const paragraph = paragraphs[low];
    const text = paragraph.textContent ?? "";
    let left = 0;
    let right = text.length;
    while (left < right) {
      let middle = (left + right) >>> 1;
      if (!isUtf16ScalarBoundary(text, middle)) middle--;
      const rect = scalarRect(paragraph, middle);
      const before = end ? rect.top < y : rect.bottom <= y + 0.5;
      if (before) left = middle + (text.codePointAt(middle)! > 0xffff ? 2 : 1);
      else right = middle;
    }
    const localStart = Number(paragraph.dataset.textStart);
    // The remainder of a paragraph's line box can be above/below its glyphs.
    // Its hidden LF is not visible text: anchor to the following paragraph.
    if (!end && text.length > 0 && left === text.length && paragraphs[low + 1])
      return Number(paragraphs[low + 1].dataset.textStart);
    return localStart + (end && left === text.length ? text.length + 1 : left);
  };
  const length = root.textContent?.length ?? 0;
  let start = Math.min(Math.max(0, length - 1), boundary(box.top, false));
  if (!isUtf16ScalarBoundary(root.textContent ?? "", start)) start--;
  return { start, end: Math.min(length, boundary(box.bottom, true)) };
}

import type { ReadAloudRange } from "../../reader/read-aloud";

const PARAGRAPH = "gripread-speech";
const SPOKEN = "gripread-speech-word";

/**
 * Whether the CSS Custom Highlight API is available. It marks read-aloud
 * progress without re-rendering the text, so the mark can move word by word.
 */
export function speechHighlightSupported(): boolean {
  return (
    typeof CSS !== "undefined" && "highlights" in CSS && typeof globalThis.Highlight === "function"
  );
}

/** A DOM range over `start`–`end` of `element`'s text content. */
function textRange(element: HTMLElement, start: number, end: number): Range | null {
  const length = element.textContent?.length ?? 0;
  start = Math.max(0, start);
  end = Math.min(length, end);
  if (end <= start) return null;
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = element.ownerDocument.createRange();
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const next = seen + node.length;
    if (!started && start < next) {
      range.setStart(node, start - seen);
      started = true;
    }
    if (started && end <= next) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen = next;
  }
  return null;
}

/**
 * Marks the paragraph being read and the words being spoken in every
 * rendered text container under `root` (pages and scroll text carry their
 * absolute start in `data-start`). Returns the on-screen box of the spoken
 * words, or of the paragraph's start, for following the reading.
 */
export function paintSpeech(
  root: ParentNode,
  paragraph: ReadAloudRange | null,
  spoken: ReadAloudRange | null,
): DOMRect | null {
  const paragraphs = new Highlight();
  const words = new Highlight();
  let focus: DOMRect | null = null;
  const containers = root.querySelectorAll<HTMLElement>(
    '[data-testid="reader-page"], [data-testid="reader-scroll-text"]',
  );
  for (const container of containers) {
    const origin = Number(container.dataset.start);
    if (!Number.isFinite(origin)) continue;
    const mark = (target: Highlight, range: ReadAloudRange) => {
      const dom = textRange(container, range.start - origin, range.end - origin);
      if (dom) target.add(dom);
      return dom;
    };
    if (paragraph) {
      const dom = mark(paragraphs, paragraph);
      if (dom && !spoken && !focus) focus = dom.getClientRects()[0] ?? null;
    }
    if (spoken) {
      const dom = mark(words, spoken);
      if (dom && !focus) focus = dom.getClientRects()[0] ?? null;
    }
  }
  CSS.highlights.set(PARAGRAPH, paragraphs);
  CSS.highlights.set(SPOKEN, words);
  return focus;
}

export function clearSpeech(): void {
  if (!speechHighlightSupported()) return;
  CSS.highlights.delete(PARAGRAPH);
  CSS.highlights.delete(SPOKEN);
}

/** Text the reader selected on a page, with its absolute UTF-16 range. */
export interface ReaderSelection {
  text: string;
  start: number;
  end: number;
  /** Viewport rectangle of the selection, for placing the menu. */
  rect: { top: number; bottom: number; left: number; right: number };
}

const TEXT_ROOT = '[data-testid="reader-page"], [data-testid="reader-scroll-text"]';

/**
 * Maps the document selection to book offsets. Rendered text keeps hidden
 * line feeds and indents, so the text before a DOM point inside a page root
 * equals the UTF-16 distance from the root's `data-start`.
 */
export function readerSelection(selection: Selection | null): ReaderSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const element = (node: Node) => (node instanceof Element ? node : node.parentElement);
  const root = element(range.startContainer)?.closest<HTMLElement>(TEXT_ROOT);
  if (!root || !root.contains(range.endContainer)) return null;
  const base = Number(root.dataset.start);
  if (!Number.isFinite(base)) return null;
  const before = root.ownerDocument.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const start = base + before.toString().length;
  const raw = range.toString();
  const text = raw.trim();
  if (!text) return null;
  const leading = raw.length - raw.trimStart().length;
  // jsdom has no layout for ranges; real engines always provide it.
  const box =
    typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    text,
    start: start + leading,
    end: start + leading + text.length,
    rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
  };
}

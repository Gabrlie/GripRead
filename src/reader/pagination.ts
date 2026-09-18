import type { ContentWindow, WindowDirection } from "../types/generated";

/** A page of already normalized content measured in UTF-16 code units. */
export interface ReaderPage {
  text: string;
  startOffset: number;
  endOffset: number;
  hasBefore: boolean;
  hasAfter: boolean;
}

/** The input accepted by a reader layout implementation. */
export interface ReaderMeasurer {
  /**
   * Measure one bounded content window. Implementations must return pages in
   * document order, even when measuring a backward window.
   */
  measure(window: ContentWindow, direction?: WindowDirection): ReaderPage[] | Promise<ReaderPage[]>;
}

/** Return every valid UTF-16 scalar boundary, including both ends. */
export function utf16Boundaries(text: string): number[] {
  const boundaries: number[] = [0];
  for (const character of text) {
    boundaries.push(boundaries[boundaries.length - 1] + character.length);
  }
  return boundaries;
}

/** Whether an offset is on a Unicode scalar boundary in a JavaScript string. */
export function isUtf16ScalarBoundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    return false;
  }
  if (offset === 0) {
    return text.length === 0 || !isLowSurrogate(text.charCodeAt(0));
  }
  if (offset === text.length) {
    return !isHighSurrogate(text.charCodeAt(text.length - 1));
  }
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return !(isHighSurrogate(previous) && isLowSurrogate(current));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function pageFromRange(
  text: string,
  startOffset: number,
  localStart: number,
  localEnd: number,
  totalLength: number,
): ReaderPage {
  const start = startOffset + localStart;
  const end = startOffset + localEnd;
  return {
    text: text.slice(localStart, localEnd),
    startOffset: start,
    endOffset: end,
    hasBefore: start > 0,
    hasAfter: end < totalLength,
  };
}

/**
 * Deterministic pagination helper retained for pure protocol tests and
 * environments that already supply their own page budget. Production reader
 * sessions use ReaderMeasurer so typography and viewport dimensions decide
 * page boundaries.
 */
export function paginateText(text: string, startOffset = 0, unitsPerPage = 2000): ReaderPage[] {
  if (unitsPerPage <= 0 || !Number.isFinite(unitsPerPage)) {
    throw new RangeError("unitsPerPage must be positive");
  }
  if (!Number.isInteger(startOffset) || startOffset < 0) {
    throw new RangeError("startOffset must be a non-negative integer");
  }

  const boundaries = utf16Boundaries(text);
  const pages: ReaderPage[] = [];
  let cursor = 0;
  while (cursor < boundaries.length - 1) {
    const start = boundaries[cursor];
    const target = start + unitsPerPage;
    let endIndex = cursor + 1;
    while (endIndex + 1 < boundaries.length && boundaries[endIndex + 1] <= target) {
      endIndex += 1;
    }
    pages.push(
      pageFromRange(
        text,
        startOffset,
        start,
        boundaries[endIndex],
        startOffset + boundaries[boundaries.length - 1],
      ),
    );
    cursor = endIndex;
  }
  return pages;
}

/** Error raised when a DOM measurement element cannot provide a real layout. */
export class ReaderMeasurementError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReaderMeasurementError";
  }
}

export interface DomReaderMeasurerOptions {
  /** Extra room, in CSS pixels, allowed for sub-pixel line-box rounding. */
  epsilon?: number;
}

interface LayoutRect {
  top: number;
  bottom: number;
  height: number;
  width: number;
}

/**
 * Measures plain normalized text in an element that has the same typography,
 * width, and height as the reader page. The element should be kept mounted in
 * the WebView and hidden from assistive technology with CSS such as
 * `position:absolute; visibility:hidden; pointer-events:none`; `display:none`
 * cannot be measured by the browser.
 *
 * The class owns only the temporary text node and Range. It does not install
 * pointer handlers, so text selection in the visible reader remains intact.
 */
export class DomReaderMeasurer implements ReaderMeasurer {
  private readonly epsilon: number;
  private disposed = false;

  public constructor(
    private readonly element: HTMLElement,
    options: DomReaderMeasurerOptions = {},
  ) {
    this.epsilon = options.epsilon ?? 0.5;
    if (!Number.isFinite(this.epsilon) || this.epsilon < 0) {
      throw new RangeError("measurement epsilon must be a non-negative number");
    }
  }

  /**
   * Return the largest scalar-safe UTF-16 prefix or suffix that fits. The
   * direction is useful to callers that need to anchor a backward window at
   * its end; `measure` uses it internally.
   */
  public fit(text: string, direction: WindowDirection = "forward"): number {
    this.assertUsable();
    const boundaries = utf16Boundaries(text);
    if (boundaries.length <= 1) {
      return 0;
    }
    // Measure each candidate as the complete text node that would be shown
    // on a page. Measuring a prefix/suffix inside the full window gives the
    // candidate a different line wrap and mishandles trailing line breaks.
    const fits = (candidate: string): boolean => this.fitsText(candidate);

    if (direction === "backward") {
      let low = 1;
      let high = boundaries.length - 1;
      let best = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const startOffset = boundaries[boundaries.length - 1 - middle];
        if (fits(text.slice(startOffset))) {
          best = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (best === 0) throw this.cannotFit();
      return boundaries[boundaries.length - 1] - boundaries[boundaries.length - 1 - best];
    }

    let low = 1;
    let high = boundaries.length - 1;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(text.slice(0, boundaries[middle]))) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best === 0) throw this.cannotFit();
    return boundaries[best];
  }

  public measure(
    contentWindow: ContentWindow,
    direction: WindowDirection = "forward",
  ): ReaderPage[] {
    this.assertUsable();
    if (contentWindow.text.length === 0) {
      return [];
    }

    const text = contentWindow.text;
    const boundaries = utf16Boundaries(text);
    const pages: ReaderPage[] = [];
    if (direction === "backward") {
      let right = boundaries.length - 1;
      while (right > 0) {
        const remaining = text.slice(0, boundaries[right]);
        const units = this.fit(remaining, "backward");
        const target = boundaries[right] - units;
        const left = greatestBoundaryAtOrBefore(boundaries, target);
        if (left >= right) throw this.cannotFit();
        pages.unshift(
          pageFromRange(
            text,
            contentWindow.startOffset,
            boundaries[left],
            boundaries[right],
            contentWindow.totalLength,
          ),
        );
        right = left;
      }
      return pages;
    }

    let left = 0;
    while (left < boundaries.length - 1) {
      const remaining = text.slice(boundaries[left]);
      const units = this.fit(remaining, "forward");
      const target = boundaries[left] + units;
      const right = greatestBoundaryAtOrBefore(boundaries, target);
      if (right <= left) throw this.cannotFit();
      pages.push(
        pageFromRange(
          text,
          contentWindow.startOffset,
          boundaries[left],
          boundaries[right],
          contentWindow.totalLength,
        ),
      );
      left = right;
    }
    return pages;
  }

  /** Release the temporary text node and prevent accidental reuse. */
  public dispose(): void {
    this.disposed = true;
    this.element.replaceChildren();
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new ReaderMeasurementError("reader measurer has been disposed");
    }
    if (typeof document === "undefined" || !this.element.isConnected) {
      throw new ReaderMeasurementError("reader measurement element is not mounted");
    }
  }

  private installText(text: string): Text {
    this.element.replaceChildren();
    const node = document.createTextNode(text);
    this.element.append(node);
    return node;
  }

  private layoutRect(): LayoutRect {
    const elementRect = this.element.getBoundingClientRect();
    const height = this.element.clientHeight || elementRect.height;
    const width = this.element.clientWidth || elementRect.width;
    if (!Number.isFinite(width) || width <= 0) {
      throw new ReaderMeasurementError(
        "reader measurement element must have a positive page width",
      );
    }
    if (!Number.isFinite(height) || height <= 0) {
      throw new ReaderMeasurementError(
        "reader measurement element must have a positive page height",
      );
    }
    return {
      top: elementRect.top,
      bottom: elementRect.top + height,
      height,
      width,
    };
  }

  private fitsText(text: string): boolean {
    this.installText(text);
    const layout = this.layoutRect();
    const scrollHeight = this.element.scrollHeight;
    if (Number.isFinite(scrollHeight) && scrollHeight > 0) {
      if (scrollHeight > layout.height + this.epsilon) return false;
    }

    const node = this.element.firstChild;
    if (!(node instanceof Text)) {
      throw new ReaderMeasurementError("reader measurement text node is unavailable");
    }
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, text.length);
    const rects = Array.from(range.getClientRects());
    if (rects.length === 0) {
      throw new ReaderMeasurementError("browser did not return text layout rectangles");
    }
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const rangeHeight = bottom - top;
    return rangeHeight <= layout.height + this.epsilon && bottom <= layout.bottom + this.epsilon;
  }

  private cannotFit(): ReaderMeasurementError {
    return new ReaderMeasurementError(
      "reader page is too small to fit one Unicode scalar with the current typography",
    );
  }
}

function greatestBoundaryAtOrBefore(boundaries: number[], target: number): number {
  let low = 0;
  let high = boundaries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (boundaries[middle] <= target) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return Math.max(0, high);
}

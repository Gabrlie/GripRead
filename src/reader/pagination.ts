export interface ReaderPage {
  text: string;
  startOffset: number;
  endOffset: number;
  hasBefore: boolean;
  hasAfter: boolean;
}

interface Boundary {
  offset: number;
  index: number;
}

function boundariesFor(text: string): Boundary[] {
  const boundaries: Boundary[] = [{ offset: 0, index: 0 }];
  let offset = 0;
  let index = 0;
  for (const character of text) {
    index += character.length;
    // `for...of` yields one Unicode code point at a time, while `length`
    // reports its UTF-16 code-unit width (1 for BMP, 2 for a supplementary
    // code point). This keeps offsets aligned with Rust's encode_utf16().
    offset += character.length;
    boundaries.push({ offset, index });
  }
  return boundaries;
}

/**
 * Paginate a normalized content window by UTF-16 units. Actual WebView
 * measurement can replace this adapter without changing ReaderLocator data.
 */
export function paginateText(
  text: string,
  startOffset = 0,
  unitsPerPage = 2000,
): ReaderPage[] {
  if (unitsPerPage <= 0 || !Number.isFinite(unitsPerPage)) {
    throw new RangeError("unitsPerPage must be positive");
  }
  const boundaries = boundariesFor(text);
  const pages: ReaderPage[] = [];
  let cursor = 0;
  while (cursor < boundaries.length - 1) {
    const start = boundaries[cursor];
    const target = start.offset + unitsPerPage;
    let endIndex = cursor + 1;
    while (
      endIndex < boundaries.length - 1 &&
      boundaries[endIndex + 1].offset <= target
    ) {
      endIndex += 1;
    }
    const end = boundaries[endIndex];
    pages.push({
      text: text.slice(start.index, end.index),
      startOffset: startOffset + start.offset,
      endOffset: startOffset + end.offset,
      hasBefore: startOffset + start.offset > 0,
      hasAfter: endIndex < boundaries.length - 1,
    });
    cursor = endIndex;
  }
  return pages;
}

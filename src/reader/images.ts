/**
 * EPUB marks in reader text (crates/core/src/epub.rs): a line holding only
 * `U+E000 + n` is image `n` of the book, and `U+F0000 + n` at a line start
 * places directory entry `n`; `U+100000` leads a line that is a
 * translation (crates/core/src/translation.rs). They stay in the text so
 * offsets hold; the renderer hides the directory and translation marks and
 * draws images in place of theirs.
 */
const IMAGE_BASE = 0xe000;
const IMAGE_LIMIT = 0x1900;

/** Directory and translation marks, and leading spaces or marks of a line. */
export const MARK = /[\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
export const MARKS = /[\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
export const LEADING = /^[\s　\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+/u;
/** Leads a translated line. */
export const TRANSLATED_MARK = "\u{100000}";

/** The image a line shows, if it is an image line. */
export function imageOfLine(line: string): number | null {
  if (line.length !== 1) return null;
  const code = line.charCodeAt(0) - IMAGE_BASE;
  return code >= 0 && code < IMAGE_LIMIT ? code : null;
}

/** Text without image or directory marks, for speech and excerpts. */
export function withoutMarks(text: string): string {
  return text.replace(MARKS, "").replace(/[-]/g, "");
}

export interface ReaderImages {
  /** The image's pixel size, known before it loads; `undefined` when unknown. */
  size(index: number): { width: number; height: number } | undefined;
  /** Its object URL once loaded. */
  url(index: number): string | undefined;
  /** Starts loading it; loaded images are filled into rendered pages. */
  load(index: number): void;
}

let active: ReaderImages | null = null;

/**
 * The open book's images. One book is read at a time, and every renderer
 * (the page, the measurement box, and page-turn copies) must draw the same
 * image boxes, so they share this instead of each taking it as a parameter.
 */
export function setReaderImages(images: ReaderImages | null): void {
  active = images;
}

export function readerImages(): ReaderImages | null {
  return active;
}

/**
 * The images of one book, loaded on first use through `read` and kept as
 * object URLs until `dispose`.
 */
export function bookImages(
  sizes: { width: number; height: number }[],
  read: (index: number) => Promise<ArrayBuffer>,
): ReaderImages & { dispose(): void } {
  const urls = new Map<number, string>();
  const loading = new Set<number>();
  let disposed = false;
  return {
    size: (index) => sizes[index],
    url: (index) => urls.get(index),
    load(index) {
      if (disposed || urls.has(index) || loading.has(index) || !sizes[index]) return;
      loading.add(index);
      void read(index).then(
        (bytes) => {
          loading.delete(index);
          if (disposed) return;
          const url = URL.createObjectURL(new Blob([bytes]));
          urls.set(index, url);
          for (const image of document.querySelectorAll<HTMLImageElement>(
            `img[data-reader-image="${index}"]`,
          ))
            image.src = url;
        },
        () => loading.delete(index),
      );
    },
    dispose() {
      disposed = true;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

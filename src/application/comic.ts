import type { LibraryService } from "../services/contracts";
import type {
  ComicChapter,
  ComicPreferences,
  LibraryBook,
  ReaderLocator,
  TocEntry,
} from "../types/generated";

/** Whether a book opens in the comic reader. */
export function isComic(book: LibraryBook | null | undefined): boolean {
  return Boolean(book?.online?.book.comic || book?.asset?.kind === "comic");
}

export const DEFAULT_COMIC: ComicPreferences = {
  mode: "scroll",
  direction: "left_to_right",
  fit: "width",
  gap: 0,
  preload: 5,
  background: "theme",
  pageNumber: true,
};

/** A place in a comic: the chapter (its position in [`comicChapters`]) and page. */
export interface ComicPlace {
  chapter: number;
  page: number;
}

/** The chapters a comic reader moves through: the contents without volume lines. */
export function comicChapters(toc: readonly TocEntry[]): TocEntry[] {
  return toc.filter((entry) => !entry.volume);
}

/**
 * The index the core knows a chapter by: an online chapter's own number
 * (its resource is `chapter-N`), or a local comic's place in its contents.
 */
export function coreIndex(chapters: readonly TocEntry[], chapter: number): number {
  const entry = chapters[chapter];
  const online = entry ? /^chapter-(\d+)$/.exec(entry.locator.resourceId) : null;
  return online ? Number(online[1]) : chapter;
}

/** The chapter a locator is in: by resource for an online comic, else by offset. */
export function chapterOf(chapters: readonly TocEntry[], locator: ReaderLocator): number {
  const byResource = chapters.findIndex(
    (entry) =>
      /^chapter-\d+$/.test(entry.locator.resourceId) &&
      entry.locator.resourceId === locator.resourceId,
  );
  if (byResource >= 0) return byResource;
  let found = 0;
  chapters.forEach((entry, index) => {
    if (entry.locator.resourceId === locator.resourceId && entry.locator.offset <= locator.offset)
      found = index;
  });
  return found;
}

/** The page of `chapter` a locator points at: the last page starting at or before it. */
export function pageOf(chapter: ComicChapter, locator: ReaderLocator): number {
  let found = 0;
  chapter.pages.forEach((page, index) => {
    if (page.offset <= locator.offset) found = index;
  });
  return found;
}

/** A locator for a page, to save and bookmark. */
export function pageLocator(bookId: string, chapter: ComicChapter, page: number): ReaderLocator {
  return {
    bookId,
    contentVersion: chapter.contentVersion,
    resourceId: chapter.resourceId,
    offset: chapter.pages[page]?.offset ?? 0,
    contextBefore: "",
    contextAfter: "",
  };
}

/** How many page images stay decoded at once; older ones are released. */
const KEPT_PAGES = 40;

/**
 * A comic's chapters and page images for one reading session. Chapters
 * are asked for once (a failure is asked again); page images become object
 * URLs, the oldest released past [`KEPT_PAGES`], and all on [`dispose`].
 */
export class ComicPages {
  private chapters = new Map<number, Promise<ComicChapter>>();
  private pages = new Map<string, Promise<string>>();
  private urls = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly service: Pick<LibraryService, "getComicChapter" | "readComicPage">,
    private readonly bookId: string,
  ) {}

  chapter(index: number): Promise<ComicChapter> {
    const known = this.chapters.get(index);
    if (known) return known;
    const loading = this.service.getComicChapter(this.bookId, index);
    this.chapters.set(index, loading);
    loading.catch(() => this.chapters.delete(index));
    return loading;
  }

  /** The page's image as an object URL. */
  page(chapter: number, page: number): Promise<string> {
    const key = `${chapter}:${page}`;
    const known = this.pages.get(key);
    if (known) {
      // Most recently used goes last.
      this.pages.delete(key);
      this.pages.set(key, known);
      return known;
    }
    const loading = this.service.readComicPage(this.bookId, chapter, page).then((bytes) => {
      const url = URL.createObjectURL(new Blob([bytes]));
      if (this.disposed) {
        URL.revokeObjectURL(url);
        throw new Error("closed");
      }
      this.urls.set(key, url);
      return url;
    });
    this.pages.set(key, loading);
    loading.catch(() => this.pages.delete(key));
    this.trim();
    return loading;
  }

  /** Fetches pages ahead without waiting for them. */
  preload(chapter: number, pages: readonly number[]) {
    for (const page of pages) void this.page(chapter, page).catch(() => undefined);
  }

  private trim() {
    while (this.pages.size > KEPT_PAGES) {
      const oldest = this.pages.keys().next().value as string;
      this.pages.delete(oldest);
      const url = this.urls.get(oldest);
      if (url) {
        URL.revokeObjectURL(url);
        this.urls.delete(oldest);
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pages.clear();
  }
}

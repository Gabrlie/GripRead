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
  tapZones: [
    "previous",
    "previous",
    "next",
    "previous",
    "menu",
    "next",
    "previous",
    "next",
    "next",
  ],
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

/** Page images downloading at once. */
export const PAGE_DOWNLOADS = 3;

/** Waiting pages further than this from the place read are not fetched. */
const FAR_PAGES = 12;

/** A page that stopped waiting because the reader moved away from it. */
export class PageCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

interface Waiting {
  chapter: number;
  page: number;
  start: () => void;
  cancel: () => void;
}

/**
 * A comic's chapters and page images for one reading session. Chapters
 * are asked for once (a failure is asked again). Pages download
 * [`PAGE_DOWNLOADS`] at a time, nearest the place being read first
 * ([`focus`]); waiting pages the reader moved far from are dropped. Images
 * become object URLs: those on screen ([`hold`]) are kept, the oldest others
 * released past [`KEPT_PAGES`], and all on [`dispose`].
 */
export class ComicPages {
  private chapters = new Map<number, Promise<ComicChapter>>();
  private pages = new Map<string, Promise<string>>();
  private urls = new Map<string, string>();
  private held = new Map<string, number>();
  private waiting: Waiting[] = [];
  private running = 0;
  private place = { chapter: 0, page: 0 };
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

  /** The place being read (core chapter index and page): nearer pages go first. */
  focus(chapter: number, page: number) {
    this.place = { chapter, page };
    const far = this.waiting.filter((item) => this.distance(item) > FAR_PAGES);
    this.waiting = this.waiting.filter((item) => this.distance(item) <= FAR_PAGES);
    for (const item of far) item.cancel();
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
    const loading = new Promise<ArrayBuffer>((resolve, reject) => {
      this.waiting.push({
        chapter,
        page,
        start: () => {
          this.running += 1;
          this.service
            .readComicPage(this.bookId, chapter, page)
            .then(resolve, reject)
            .finally(() => {
              this.running -= 1;
              this.next();
            });
        },
        cancel: () => reject(new PageCancelled()),
      });
      this.next();
    }).then((bytes) => {
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

  /** A page on screen keeps its image until [`release`]d. */
  hold(chapter: number, page: number) {
    const key = `${chapter}:${page}`;
    this.held.set(key, (this.held.get(key) ?? 0) + 1);
  }

  release(chapter: number, page: number) {
    const key = `${chapter}:${page}`;
    const count = (this.held.get(key) ?? 0) - 1;
    if (count > 0) this.held.set(key, count);
    else this.held.delete(key);
    this.trim();
  }

  /** Pages from the place read; another chapter's count from beyond this one. */
  private distance(item: { chapter: number; page: number }) {
    if (item.chapter === this.place.chapter) return Math.abs(item.page - this.place.page);
    return FAR_PAGES / 2 + Math.abs(item.chapter - this.place.chapter) * 1000 + item.page;
  }

  private next() {
    while (!this.disposed && this.running < PAGE_DOWNLOADS && this.waiting.length) {
      let nearest = 0;
      this.waiting.forEach((item, index) => {
        if (this.distance(item) < this.distance(this.waiting[nearest])) nearest = index;
      });
      const [item] = this.waiting.splice(nearest, 1);
      item.start();
    }
  }

  private trim() {
    for (const key of [...this.pages.keys()]) {
      if (this.pages.size <= KEPT_PAGES) break;
      if (this.held.has(key)) continue;
      this.pages.delete(key);
      const url = this.urls.get(key);
      if (url) {
        URL.revokeObjectURL(url);
        this.urls.delete(key);
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const item of this.waiting) item.cancel();
    this.waiting = [];
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pages.clear();
  }
}

import type { LibraryBook, LibraryGroup, TocEntry } from "../types/generated";
import type { LibraryService, ReaderService } from "../services/contracts";

export interface ShelfChapterLabels {
  current: string;
  latest: string;
}
export function chapterLabels(book: LibraryBook, entries: TocEntry[]): ShelfChapterLabels {
  const currentEntries = entries.filter(
    (entry) => entry.locator.contentVersion === book.book.contentVersion,
  );
  const saved = book.locator;
  const position = saved?.contentVersion === book.book.contentVersion ? saved.offset : null;
  const chapter =
    position === null
      ? undefined
      : currentEntries.filter((entry) => entry.locator.offset <= position).at(-1);
  return {
    current:
      saved && position === null ? "待重新定位" : !saved ? "尚未阅读" : (chapter?.title ?? "全文"),
    latest: currentEntries.at(-1)?.title ?? "全文",
  };
}
interface ShelfSnapshot {
  groups: LibraryGroup[];
  chapters: Record<string, ShelfChapterLabels>;
  chapterErrors: Record<string, string>;
  loading: boolean;
  saving: boolean;
  error: string | null;
}
/** Owns local grouping and chapter presentation; the page only renders its snapshot. */
export class ShelfStore {
  private snapshot: ShelfSnapshot = {
    groups: [],
    chapters: {},
    chapterErrors: {},
    loading: true,
    saving: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private groupQueue: Promise<void> = Promise.resolve();
  private pendingChanges = 0;
  private chapterRevision = 0;
  private chapterCache = new Map<string, { contentVersion: string; entries: TocEntry[] }>();
  constructor(
    private library: LibraryService,
    private reader: ReaderService,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ShelfSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  load = async (books: LibraryBook[]) => {
    const revision = ++this.chapterRevision;
    this.update({ loading: true });
    const groups = this.enqueueGroups(() => this.refreshGroups()).catch(() => {
      // refreshGroups exposes failures; loading the shelf preserves its data.
    });
    // Slow chapter reads never block group edits. Only a newer book snapshot
    // invalidates their results, independently of the ordered group requests.
    await Promise.all([groups, this.loadChapters(books, revision)]);
    if (revision === this.chapterRevision) this.update({ loading: false });
  };
  private enqueueGroups<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.groupQueue.then(action);
    this.groupQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  private async refreshGroups() {
    this.update({ error: null });
    try {
      const groups = await this.library.listGroups();
      this.update({ groups });
    } catch (error) {
      this.update({ error: String(error) });
      throw error;
    }
  }
  private change(action: () => Promise<unknown>): Promise<void> {
    this.pendingChanges += 1;
    this.update({ saving: true });
    return this.enqueueGroups(async () => {
      this.update({ error: null });
      try {
        await action();
        await this.refreshGroups();
      } catch (error) {
        this.update({ error: String(error) });
        throw error;
      } finally {
        this.pendingChanges -= 1;
        this.update({ saving: this.pendingChanges > 0 });
      }
    });
  }
  private async loadChapters(books: LibraryBook[], revision: number) {
    const results = await Promise.all(
      books.map(async (book) => {
        try {
          if (book.asset.availability === "missing") throw new Error("文件缺失，无法读取目录");
          const entries = await this.reader.listToc(book.book.id);
          return { book, entries, error: null };
        } catch (error) {
          return { book, entries: null, error: String(error) };
        }
      }),
    );
    if (revision !== this.chapterRevision) return;
    const chapters: ShelfSnapshot["chapters"] = {};
    const chapterErrors: ShelfSnapshot["chapterErrors"] = {};
    const cache: typeof this.chapterCache = new Map();
    for (const { book, entries, error } of results) {
      const id = book.book.id;
      const previous = this.chapterCache.get(id);
      const known = entries
        ? { contentVersion: book.book.contentVersion, entries }
        : previous?.contentVersion === book.book.contentVersion
          ? previous
          : undefined;
      if (known) cache.set(id, known);
      if (error !== null) chapterErrors[id] = error;
      chapters[id] = known
        ? chapterLabels(book, known.entries)
        : {
            current: book.locator
              ? book.locator.contentVersion === book.book.contentVersion
                ? "目录读取失败"
                : "待重新定位"
              : "尚未阅读",
            latest: "目录读取失败",
          };
    }
    this.chapterCache = cache;
    this.update({ chapters, chapterErrors });
  }
  create = (name: string) => this.change(() => this.library.createGroup(name));
  rename = (id: string, name: string) => this.change(() => this.library.renameGroup(id, name));
  remove = (id: string) => this.change(() => this.library.deleteGroup(id));
  setBookGroups = (bookId: string, groupIds: string[]) =>
    this.change(() => this.library.setBookGroups(bookId, groupIds));
}

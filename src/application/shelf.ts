import type {
  LibraryBook,
  LibraryGroup,
  ShelfPlacement,
  ShelfState,
  TocEntry,
} from "../types/generated";
import type { LibraryService, ReaderService } from "../services/contracts";

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:^|\s)([a-z][a-z0-9_]*)\s*:/i);
  return match?.[1];
}

function isValidationError(error: unknown): boolean {
  return errorCode(error) === "invalid_argument" || errorCode(error) === "not_found";
}

interface FailedWrite {
  revision: number;
  error: unknown;
  retry: (() => Promise<unknown>) | null;
}

export interface ShelfChapterLabels {
  current: string;
  latest: string;
  /** Chapters after the one being read (all of them when unread). */
  remaining?: number;
  /** All chapters, to tell when a book gained chapters since it was read. */
  total?: number;
}

const READ_COUNTS_KEY = "gripread.chaptersWhenRead";

function readCounts(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(READ_COUNTS_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Remembers how many chapters a book had when it was last read. */
export function rememberChaptersWhenRead(bookId: string, count: number) {
  try {
    localStorage.setItem(READ_COUNTS_KEY, JSON.stringify({ ...readCounts(), [bookId]: count }));
  } catch {
    // The red mark is a convenience.
  }
}

/** Whether a book gained chapters since it was last read (the red mark). */
export function gainedChapters(book: LibraryBook, labels: ShelfChapterLabels | undefined): boolean {
  if (book.online) return book.online.newChapters > 0;
  const before = readCounts()[book.book.id];
  return before !== undefined && labels?.total !== undefined && labels.total > before;
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
  const chapters = currentEntries.filter((entry) => !entry.volume);
  const at = chapter ? chapters.findIndex((entry) => entry.ordinal === chapter.ordinal) : -1;
  return {
    current:
      saved && position === null ? "待重新定位" : !saved ? "尚未阅读" : (chapter?.title ?? "全文"),
    latest: currentEntries.at(-1)?.title ?? "全文",
    remaining:
      chapters.length > 1
        ? saved
          ? Math.max(0, chapters.length - at - 1)
          : chapters.length
        : undefined,
    total: chapters.length,
  };
}
/** An online book's labels come from the chapter it is in and the source's latest. */
export function onlineChapterLabels(book: LibraryBook): ShelfChapterLabels | null {
  const online = book.online;
  if (!online) return null;
  return {
    current: online.readChapterTitle || (book.locator ? "全文" : "尚未阅读"),
    latest: online.book.latestChapterTitle || "",
    remaining:
      online.readChapter === null || !book.locator
        ? online.totalChapters
        : Math.max(0, online.totalChapters - online.readChapter - 1),
    total: online.totalChapters,
  };
}

/** The shelf's built-in groups: every book, then the three reading states. */
export const READING_GROUPS: { id: "all" | ShelfState; name: string }[] = [
  { id: "all", name: "全部" },
  { id: "reading", name: "在读" },
  { id: "unread", name: "未读" },
  { id: "finished", name: "读完" },
];

/**
 * The reading state derived from progress: unread without a position,
 * finished once the position reaches the last chapter (or 99% of a book
 * without chapters), reading otherwise.
 */
export function automaticState(book: LibraryBook, entries: TocEntry[] | null): ShelfState {
  const saved = book.locator;
  if (book.online) {
    if (!saved) return "unread";
    const last = book.online.totalChapters - 1;
    return last > 0 && (book.online.readChapter ?? 0) >= last ? "finished" : "reading";
  }
  if (!saved || saved.contentVersion !== book.book.contentVersion)
    return saved ? "reading" : "unread";
  const current = (entries ?? []).filter(
    (entry) => entry.locator.contentVersion === book.book.contentVersion,
  );
  const last = current.at(-1);
  if (current.length > 1 && last && saved.offset >= last.locator.offset) return "finished";
  const total = book.totalLength ?? 0;
  if (total > 0 && saved.offset / total >= 0.99) return "finished";
  return "reading";
}

/**
 * The one shelf group a book is shown in besides 全部: its user group, a
 * reading state the reader chose by moving it, or its automatic state.
 */
export function shelfGroupOf(
  book: LibraryBook,
  groups: LibraryGroup[],
  automatic: ShelfState,
): string {
  const group = groups.find((item) => item.bookIds.includes(book.book.id));
  return group?.id ?? book.shelfState ?? automatic;
}

interface ShelfSnapshot {
  groups: LibraryGroup[];
  /** Reading states derived from progress, by book id. */
  automatic: Record<string, ShelfState>;
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
    automatic: {},
    chapters: {},
    chapterErrors: {},
    loading: true,
    saving: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private groupQueue: Promise<void> = Promise.resolve();
  private pendingChanges = 0;
  private pendingWrites = new Set<Promise<void>>();
  private writeRevision = 0;
  private failedWrites = new Map<string, FailedWrite>();
  private chapterRevision = 0;
  private chapterCache = new Map<string, { contentVersion: string; entries: TocEntry[] }>();
  constructor(
    private library: LibraryService,
    private reader: ReaderService,
    /** Reloads the book list after a move changes a book's reading state. */
    private booksChanged: () => Promise<void> = async () => undefined,
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
  /** A rule change invalidates derived labels even when the text version is unchanged. */
  invalidateChapterCache = (bookId: string) => {
    ++this.chapterRevision;
    this.chapterCache.delete(bookId);
    const chapters = { ...this.snapshot.chapters };
    const chapterErrors = { ...this.snapshot.chapterErrors };
    delete chapters[bookId];
    delete chapterErrors[bookId];
    this.update({ chapters, chapterErrors, loading: false });
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
  private change(
    key: string,
    action: () => Promise<unknown>,
    retry: (() => Promise<unknown>) | null = action,
  ): Promise<void> {
    this.pendingChanges += 1;
    this.update({ saving: true });
    const revision = ++this.writeRevision;
    let resolveWrite!: () => void;
    let rejectWrite!: (error: unknown) => void;
    const write = new Promise<void>((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    });
    this.pendingWrites.add(write);
    void write.catch(() => undefined).finally(() => this.pendingWrites.delete(write));
    return this.enqueueGroups(async () => {
      this.update({ error: null });
      try {
        try {
          await action();
          const previous = this.failedWrites.get(key);
          if (previous && previous.revision < revision) this.failedWrites.delete(key);
          resolveWrite();
        } catch (error) {
          if (!isValidationError(error)) {
            this.failedWrites.set(key, { revision, error, retry });
          }
          rejectWrite(error);
          throw error;
        }
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
  hasUnresolvedWrites = () => this.failedWrites.size > 0;
  discardFailedWrites = () => {
    // Explicit cancellation abandons only rejected intents; pending writes and
    // committed records are never touched.
    this.failedWrites.clear();
  };
  flush = async (retryFailed = false) => {
    for (;;) {
      const writes = [...this.pendingWrites];
      if (writes.length) await Promise.allSettled(writes);
      if (this.pendingWrites.size) continue;
      const failures = [...this.failedWrites.entries()];
      if (!failures.length) return;
      if (!retryFailed) throw failures[0][1].error;
      for (const [key, failure] of failures) {
        if (this.failedWrites.get(key)?.revision !== failure.revision) continue;
        if (!failure.retry) throw failure.error;
        this.failedWrites.delete(key);
        try {
          await failure.retry();
        } catch (error) {
          const newer = this.failedWrites.get(key);
          if (!newer || newer.revision <= failure.revision)
            this.failedWrites.set(key, { ...failure, error });
          throw error;
        }
      }
    }
  };
  private async loadChapters(books: LibraryBook[], revision: number) {
    const results = await Promise.all(
      books.map(async (book) => {
        try {
          // An online book's labels need no contents listing.
          if (book.online) return { book, entries: [] as TocEntry[], error: null };
          if (book.asset?.availability === "missing") throw new Error("文件缺失，无法读取目录");
          const { entries } = await this.reader.listToc(book.book.id);
          return { book, entries, error: null };
        } catch (error) {
          return { book, entries: null, error: String(error) };
        }
      }),
    );
    if (revision !== this.chapterRevision) return;
    const chapters: ShelfSnapshot["chapters"] = {};
    const chapterErrors: ShelfSnapshot["chapterErrors"] = {};
    const automatic: ShelfSnapshot["automatic"] = {};
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
      automatic[id] = automaticState(book, known?.entries ?? null);
      if (error !== null) chapterErrors[id] = error;
      chapters[id] =
        onlineChapterLabels(book) ??
        (known
          ? chapterLabels(book, known.entries)
          : {
              current: book.locator
                ? book.locator.contentVersion === book.book.contentVersion
                  ? "目录读取失败"
                  : "待重新定位"
                : "尚未阅读",
              latest: "目录读取失败",
            });
    }
    this.chapterCache = cache;
    this.update({ chapters, chapterErrors, automatic });
  }
  create = (name: string) => {
    const trimmed = name.trim();
    const key = `group:create:${trimmed}`;
    const reconcile = async () => {
      const groups = await this.library.listGroups();
      this.update({ groups });
      if (!groups.some((group) => group.name.trim() === trimmed)) {
        throw new Error(`分组“${trimmed}”仍未确认，请重试或取消操作`);
      }
    };
    return this.change(key, () => this.library.createGroup(name), reconcile);
  };
  rename = (id: string, name: string) =>
    this.change(`group:${id}:rename`, () => this.library.renameGroup(id, name));
  remove = (id: string) => this.change(`group:${id}:remove`, () => this.library.deleteGroup(id));
  /** A manual move holds until the book is moved again; automatic restores derivation. */
  move = (bookId: string, placement: ShelfPlacement) =>
    this.change(`book:${bookId}:groups`, async () => {
      await this.library.moveBook(bookId, placement);
      await this.booksChanged();
    });
}

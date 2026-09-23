import { describe, expect, it, vi } from "vitest";
import type {
  AppServices,
  LibraryService,
  ReaderService,
  SettingsService,
} from "../services/contracts";
import type { Book, LibraryGroup, ReaderPreferences, ShelfPreferences } from "../types/generated";
import { AppRuntime } from "./runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function services(overrides: Partial<LibraryService> = {}): AppServices {
  const library: LibraryService = {
    pickAndImportTxt: vi.fn(async () => null),
    startImport: vi.fn(),
    getImportStatus: vi.fn(),
    cancelImport: vi.fn(),
    listBooks: vi.fn(async () => []),
    listRemovedBooks: vi.fn(async () => []),
    updateBook: vi.fn(),
    removeBook: vi.fn(),
    restoreBook: vi.fn(),
    listGroups: vi.fn(async () => []),
    createGroup: vi.fn(),
    renameGroup: vi.fn(),
    deleteGroup: vi.fn(),
    setBookGroups: vi.fn(),
    onImportProgress: vi.fn(async () => () => {}),
    getTxtEncoding: vi.fn(),
    pickAndReassociateTxt: vi.fn(),
    reassociateTxtSource: vi.fn(),
    startTxtDecode: vi.fn(),
    getTxtDecodeStatus: vi.fn(),
    cancelTxtDecode: vi.fn(),
    onTxtDecodeProgress: vi.fn(async () => () => {}),
    ...overrides,
  };
  const reader: ReaderService = {
    readContentWindow: vi.fn(),
    resolveLocator: vi.fn(),
    saveReaderLocator: vi.fn(),
    getSavedReaderLocator: vi.fn(),
    listToc: vi.fn(async () => []),
    getTocRule: vi.fn(async () => ({ mode: "automatic" as const, pattern: "" })),
    previewTocRule: vi.fn(async () => ({ entries: [] })),
    saveTocRule: vi.fn(async (request) => request.rule),
    listBookmarks: vi.fn(),
    addBookmark: vi.fn(),
    deleteBookmark: vi.fn(),
    search: vi.fn(),
    cancelSearch: vi.fn(),
  };
  const settings: SettingsService = {
    getSettings: vi.fn(async (): Promise<ReaderPreferences> => ({
      theme: "system",
      paperTone: "warm-tea",
      oledBlack: false,
      fontSize: 18,
      lineHeight: 1.8,
      fontFamily: "serif",
      pageTurnEffect: "curl",
      autoPageSeconds: 8,
    })),
    saveSettings: vi.fn(async (value) => value),
    getShelfPreferences: vi.fn(async (): Promise<ShelfPreferences> => ({
      layout: "list",
      sort: "recent_read",
      groupId: "all",
    })),
    saveShelfPreferences: vi.fn(async (value) => value),
  };
  return { library, reader, settings };
}

const book: Book = {
  id: "book",
  title: "标题",
  author: null,
  contentVersion: "version",
  createdAt: 1,
  updatedAt: 1,
};
const group: LibraryGroup = { id: "group", name: "分组", bookIds: [] };

describe("runtime durability flush", () => {
  it("waits for accepted metadata and group mutations before resolving", async () => {
    const metadata = deferred<Book>();
    const groupCommit = deferred<LibraryGroup>();
    const appServices = services({
      updateBook: vi.fn(() => metadata.promise),
      createGroup: vi.fn(() => groupCommit.promise),
    });
    const runtime = new AppRuntime(appServices);
    const edit = runtime.library.edit({ bookId: book.id, title: book.title, author: null });
    const create = runtime.shelf.create(group.name);
    let flushed = false;
    const flush = runtime.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    metadata.resolve(book);
    groupCommit.resolve(group);
    await Promise.all([edit, create, flush]);
    expect(flushed).toBe(true);
  });

  it("reports a failed write and retries only that write when explicitly requested", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValue(book);
    const appServices = services({ updateBook: update });
    const runtime = new AppRuntime(appServices);
    await expect(
      runtime.library.edit({ bookId: book.id, title: book.title, author: null }),
    ).rejects.toThrow("metadata unavailable");
    await expect(runtime.flush()).rejects.toThrow("metadata unavailable");
    expect(update).toHaveBeenCalledTimes(1);
    await runtime.flush(true);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("lets a newer metadata intent supersede an older failed one", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValue(book);
    const runtime = new AppRuntime(services({ updateBook: update }));
    await expect(
      runtime.library.edit({ bookId: book.id, title: "Old", author: null }),
    ).rejects.toThrow("metadata unavailable");
    await runtime.library.edit({ bookId: book.id, title: "New", author: null });
    await runtime.flush(true);
    expect(update.mock.calls.map(([request]) => request.title)).toEqual(["Old", "New"]);
  });

  it("retains independent failed intents until each idempotent retry succeeds", async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error("metadata unavailable"));
    const remove = vi.fn().mockRejectedValueOnce(new Error("archive unavailable"));
    const runtime = new AppRuntime(services({ updateBook: update, removeBook: remove }));
    const first = runtime.library.edit({ bookId: "one", title: "One", author: null });
    const second = runtime.library.remove({
      book: { ...book, id: "two" },
      asset: {} as never,
      locator: null,
      totalLength: null,
      txtEncoding: null,
      lastReadAt: null,
      removedAt: null,
    });
    await expect(first).rejects.toThrow("metadata unavailable");
    await expect(second).rejects.toThrow("archive unavailable");
    await expect(runtime.flush()).rejects.toThrow();
    vi.mocked(update).mockResolvedValue(book);
    vi.mocked(remove).mockResolvedValue(undefined);
    await runtime.flush(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("does not poison exit for a known group validation rejection", async () => {
    const createGroup = vi.fn().mockRejectedValue(new Error("invalid_argument: duplicate"));
    const runtime = new AppRuntime(services({ createGroup }));
    await expect(runtime.shelf.create("重复分组")).rejects.toThrow("invalid_argument");
    await runtime.flush();
    await runtime.flush(true);
    expect(createGroup).toHaveBeenCalledOnce();
  });

  it("does not retry a failed group creation whose commit outcome is unknown", async () => {
    const createGroup = vi.fn().mockRejectedValue(new Error("group commit uncertain"));
    const appServices = services({ createGroup });
    const runtime = new AppRuntime(appServices);
    await expect(runtime.shelf.create(group.name)).rejects.toThrow("group commit uncertain");
    await expect(runtime.flush()).rejects.toThrow("group commit uncertain");
    await expect(runtime.flush(true)).rejects.toThrow("仍未确认");
    expect(createGroup).toHaveBeenCalledOnce();
  });

  it("reconciles an uncertain group creation before allowing retry to finish", async () => {
    const createGroup = vi.fn().mockRejectedValue(new Error("io: bridge lost"));
    const listGroups = vi.fn().mockResolvedValue([group]);
    const runtime = new AppRuntime(services({ createGroup, listGroups }));
    await expect(runtime.shelf.create(group.name)).rejects.toThrow("bridge lost");
    await expect(runtime.flush()).rejects.toThrow("bridge lost");
    await runtime.flush(true);
    expect(createGroup).toHaveBeenCalledOnce();
    expect(listGroups).toHaveBeenCalled();
  });

  it("does not replay a committed write when only its refresh failed", async () => {
    const update = vi.fn().mockResolvedValue(book);
    const listBooks = vi.fn().mockRejectedValue(new Error("refresh unavailable"));
    const runtime = new AppRuntime(services({ updateBook: update, listBooks }));
    await expect(
      runtime.library.edit({ bookId: book.id, title: book.title, author: null }),
    ).rejects.toThrow("refresh unavailable");
    await runtime.flush(true);
    expect(update).toHaveBeenCalledOnce();
  });
  it("can explicitly abandon an unresolved creation without replay or file deletion", async () => {
    const createGroup = vi.fn().mockRejectedValue(new Error("group outcome uncertain"));
    const appServices = services({ createGroup });
    const runtime = new AppRuntime(appServices);
    await expect(runtime.shelf.create("待确认")).rejects.toThrow("uncertain");
    await expect(runtime.flush(true)).rejects.toThrow("仍未确认");
    expect(runtime.shelf.hasUnresolvedWrites()).toBe(true);
    runtime.shelf.discardFailedWrites();
    await runtime.flush();
    expect(createGroup).toHaveBeenCalledOnce();
    expect(appServices.library.deleteGroup).not.toHaveBeenCalled();
    expect(appServices.library.removeBook).not.toHaveBeenCalled();
  });
});

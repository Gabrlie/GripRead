import { describe, expect, it, vi } from "vitest";
import type { LibraryService, ReaderService } from "../services/contracts";
import type { LibraryBook, LibraryGroup, TocEntry } from "../types/generated";
import { ShelfStore } from "./shelf";
import { ruleServiceMocks, tocEntry, tocListing } from "../test/toc";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const entry: LibraryBook = {
  book: {
    id: "book",
    title: "小说",
    author: null,
    contentVersion: "v1",
    createdAt: 1,
    updatedAt: 1,
  },
  asset: {
    id: "asset",
    bookId: "book",
    kind: "txt",
    sha256: "v1",
    byteLength: 100,
    contentVersion: "v1",
    availability: "ready",
    createdAt: 1,
  },
  locator: {
    bookId: "book",
    resourceId: "asset",
    contentVersion: "v1",
    offset: 0,
    contextBefore: "",
    contextAfter: "第一章",
  },
  totalLength: 100,
  txtEncoding: null,
  lastReadAt: null,
  removedAt: null,
  shelfState: null,
  coverAssetId: null,
  useReplaceRules: true,
  inCloud: false,
  online: null,
};
const chapters: TocEntry[] = [
  tocEntry(0, "第一章", entry.locator!),
  tocEntry(1, "第二章", { ...entry.locator!, offset: 20 }),
];
const original: LibraryGroup = { id: "original", name: "已有分组", bookIds: [] };
const created: LibraryGroup = { id: "created", name: "新建分组", bookIds: [] };

function setup() {
  const library: LibraryService = {
    listGroups: vi.fn(async () => [original]),
    createGroup: vi.fn(async () => created),
    renameGroup: vi.fn(async (id, name) => ({ id, name, bookIds: [] })),
    deleteGroup: vi.fn(async () => {}),
    moveBook: vi.fn(async () => undefined),
    ensureTextTransforms: vi.fn(async () => null),
    setBookReplaceRules: vi.fn(async () => undefined),
    pickTxtFiles: vi.fn(async () => []),
    pickTxtFolder: vi.fn(async () => []),
    pickBookCover: vi.fn(async () => false),
    clearBookCover: vi.fn(async () => undefined),
    readAsset: vi.fn(async () => new ArrayBuffer(0)),
    addReadingTime: vi.fn(async () => undefined),
    readingStats: vi.fn(async () => ({ totalSeconds: 0, todaySeconds: 0, days: [], books: [] })),
    listRemovedBooks: vi.fn(async () => []),
    updateBook: vi.fn(),
    removeBook: vi.fn(),
    deleteBook: vi.fn(),
    restoreBook: vi.fn(),
    listBooks: vi.fn(async () => []),
    pickAndImportTxt: vi.fn(async () => null),
    startImport: vi.fn(),
    getImportStatus: vi.fn(),
    cancelImport: vi.fn(),
    onImportProgress: vi.fn(async () => () => {}),
    getTxtEncoding: vi.fn(),
    pickAndReassociateTxt: vi.fn(),
    reassociateTxtSource: vi.fn(),
    startTxtDecode: vi.fn(),
    getTxtDecodeStatus: vi.fn(),
    cancelTxtDecode: vi.fn(),
    onTxtDecodeProgress: vi.fn(async () => () => {}),
    getBookInfo: vi.fn(),
  };
  const reader: ReaderService = {
    listToc: vi.fn(async () => tocListing(chapters)),
    ...ruleServiceMocks(),
    readContentWindow: vi.fn(),
    resolveLocator: vi.fn(),
    resolveOffset: vi.fn(),
    saveReaderLocator: vi.fn(),
    getSavedReaderLocator: vi.fn(),
    listBookmarks: vi.fn(),
    addBookmark: vi.fn(),
    deleteBookmark: vi.fn(),
    updateBookmarkNote: vi.fn(async () => undefined),
    listReplaceRules: vi.fn(async () => []),
    saveReplaceRule: vi.fn(async (rule) => rule),
    deleteReplaceRules: vi.fn(async () => undefined),
    orderReplaceRules: vi.fn(async () => []),
    importReplaceRules: vi.fn(async () => []),
    exportReplaceRules: vi.fn(async () => "[]"),
    testReplaceRule: vi.fn(async (_rule, sample: string) => sample),
    search: vi.fn(),
    cancelSearch: vi.fn(),
  };
  return { library, reader, store: new ShelfStore(library, reader) };
}

describe("shelf group request ordering", () => {
  it("does not let a refresh started during creation overwrite the committed group", async () => {
    const { library, reader, store } = setup();
    const commit = deferred<LibraryGroup>();
    const toc = deferred<TocEntry[]>();
    let groups = [original];
    vi.mocked(library.createGroup).mockImplementation(async () => {
      const group = await commit.promise;
      groups = [...groups, group];
      return group;
    });
    vi.mocked(library.listGroups).mockImplementation(async () => groups);
    vi.mocked(reader.listToc).mockReturnValue(toc.promise.then((entries) => tocListing(entries)));
    const change = store.create(created.name);
    await vi.waitFor(() => expect(library.createGroup).toHaveBeenCalledOnce());
    const load = store.load([entry]);
    await Promise.resolve();
    expect(library.listGroups).not.toHaveBeenCalled();
    commit.resolve(created);
    await change;
    expect(store.getSnapshot().groups).toEqual([original, created]);
    expect(store.getSnapshot().loading).toBe(true);
    toc.resolve(chapters);
    await load;
    expect(store.getSnapshot()).toMatchObject({
      groups: [original, created],
      loading: false,
      saving: false,
      chapters: { book: { current: "第一章", latest: "第二章" } },
    });
  });

  it("finishes an earlier group read before beginning a later mutation", async () => {
    const { library, store } = setup();
    const read = deferred<LibraryGroup[]>();
    vi.mocked(library.listGroups)
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue([original, created]);
    const load = store.load([]);
    await vi.waitFor(() => expect(library.listGroups).toHaveBeenCalledOnce());
    const change = store.create(created.name);
    await Promise.resolve();
    expect(library.createGroup).not.toHaveBeenCalled();
    read.resolve([original]);
    await Promise.all([load, change]);
    expect(store.getSnapshot().groups).toEqual([original, created]);
  });

  it("queues repeated writes and keeps saving true until the last commit finishes", async () => {
    const { library, store } = setup();
    const first = deferred<LibraryGroup>();
    const second = deferred<LibraryGroup>();
    vi.mocked(library.createGroup).mockReturnValue(first.promise);
    vi.mocked(library.renameGroup).mockReturnValue(second.promise);
    vi.mocked(library.listGroups)
      .mockResolvedValueOnce([created])
      .mockResolvedValueOnce([{ ...created, name: "新名称" }]);
    const create = store.create(created.name);
    const rename = store.rename(created.id, "新名称");
    let renameSettled = false;
    void rename.then(() => {
      renameSettled = true;
    });
    await vi.waitFor(() => expect(library.createGroup).toHaveBeenCalledOnce());
    expect(library.renameGroup).not.toHaveBeenCalled();
    expect(renameSettled).toBe(false);
    first.resolve(created);
    await create;
    expect(store.getSnapshot().saving).toBe(true);
    expect(renameSettled).toBe(false);
    await vi.waitFor(() => expect(library.renameGroup).toHaveBeenCalledWith(created.id, "新名称"));
    second.resolve({ ...created, name: "新名称" });
    await rename;
    expect(store.getSnapshot()).toMatchObject({
      saving: false,
      groups: [{ ...created, name: "新名称" }],
    });
  });

  it("rejects failed mutations without blocking later queued operations", async () => {
    const { library, store } = setup();
    vi.mocked(library.createGroup).mockRejectedValueOnce(new Error("duplicate group"));
    vi.mocked(library.listGroups).mockResolvedValue([]);
    const failed = store.create("重复名称");
    const rejection = expect(failed).rejects.toThrow("duplicate group");
    const removed = store.remove(original.id);
    await rejection;
    await removed;
    expect(library.deleteGroup).toHaveBeenCalledWith(original.id);
    expect(store.getSnapshot()).toMatchObject({ groups: [], saving: false, error: null });
  });

  it("accepts an empty group snapshot and preserves earlier groups on a read failure", async () => {
    const { library, store } = setup();
    await store.load([]);
    vi.mocked(library.listGroups).mockRejectedValueOnce(new Error("database unavailable"));
    await store.load([]);
    expect(store.getSnapshot()).toMatchObject({ groups: [original], loading: false });
    expect(store.getSnapshot().error).toContain("database unavailable");
    vi.mocked(library.listGroups).mockResolvedValueOnce([]);
    await store.load([]);
    expect(store.getSnapshot()).toMatchObject({ groups: [], loading: false, error: null });
  });
});

describe("shelf chapter snapshots", () => {
  it("reports a per-book failure, retains known chapters, and clears the error on retry", async () => {
    const { reader, store } = setup();
    await store.load([entry]);
    const advanced = { ...entry, locator: chapters[1].locator };
    vi.mocked(reader.listToc).mockRejectedValueOnce(new Error("content changed"));
    await store.load([advanced]);
    expect(store.getSnapshot()).toMatchObject({
      groups: [original],
      error: null,
      loading: false,
      chapters: { book: { current: "第二章", latest: "第二章" } },
    });
    expect(store.getSnapshot().chapterErrors.book).toContain("content changed");
    await store.load([advanced]);
    expect(store.getSnapshot().chapterErrors).toEqual({});
    expect(store.getSnapshot().chapters.book.current).toBe("第二章");
  });

  it("does not reuse chapters across content versions or hide books with missing files", async () => {
    const { reader, store } = setup();
    await store.load([entry]);
    const missing: LibraryBook = {
      ...entry,
      book: { ...entry.book, contentVersion: "v2" },
      asset: { ...entry.asset!, contentVersion: "v2", availability: "missing" },
    };
    await store.load([missing]);
    expect(reader.listToc).toHaveBeenCalledOnce();
    expect(store.getSnapshot().chapters.book).toEqual({
      current: "待重新定位",
      latest: "目录读取失败",
    });
    expect(store.getSnapshot().chapterErrors.book).toContain("文件缺失");
    expect(store.getSnapshot().error).toBeNull();
  });

  it("does not restore old-rule labels after invalidation, failed reload, or a late read", async () => {
    const { reader, store } = setup();
    await store.load([entry]);
    expect(store.getSnapshot().chapters.book.latest).toBe("第二章");
    const old = deferred<TocEntry[]>();
    vi.mocked(reader.listToc).mockReturnValueOnce(
      old.promise.then((entries) => tocListing(entries)),
    );
    const staleLoad = store.load([entry]);
    store.invalidateChapterCache(entry.book.id);
    vi.mocked(reader.listToc).mockRejectedValueOnce(new Error("new directory unavailable"));
    await store.load([entry]);
    old.resolve(chapters);
    await staleLoad;
    expect(store.getSnapshot().chapters.book.latest).toBe("目录读取失败");
    expect(store.getSnapshot().chapterErrors.book).toContain("new directory unavailable");
    expect(store.getSnapshot().loading).toBe(false);
    await store.load([entry]);
    expect(store.getSnapshot().chapters.book.latest).toBe("第二章");
    expect(store.getSnapshot().chapterErrors).toEqual({});
  });

  it.each(["success", "failure"] as const)(
    "ignores an older chapter %s after a newer snapshot",
    async (outcome) => {
      const { reader, store } = setup();
      const old = deferred<TocEntry[]>();
      vi.mocked(reader.listToc).mockReturnValueOnce(
        old.promise.then((entries) => tocListing(entries)),
      );
      const stale = store.load([entry]);
      const nextEntry: LibraryBook = {
        ...entry,
        book: { ...entry.book, id: "next" },
        locator: { ...entry.locator!, bookId: "next" },
      };
      await store.load([nextEntry]);
      const nextSnapshot = store.getSnapshot();
      if (outcome === "success") old.resolve(chapters);
      else old.reject(new Error("late read failure"));
      await stale;
      expect(store.getSnapshot()).toBe(nextSnapshot);
      expect(Object.keys(store.getSnapshot().chapters)).toEqual(["next"]);
      expect(store.getSnapshot().chapterErrors).toEqual({});
    },
  );

  it("still reports chapter results when the independent group request fails", async () => {
    const { library, reader, store } = setup();
    vi.mocked(library.listGroups).mockRejectedValue(new Error("group failure"));
    vi.mocked(reader.listToc).mockRejectedValue(new Error("chapter failure"));
    await store.load([entry]);
    expect(store.getSnapshot().error).toContain("group failure");
    expect(store.getSnapshot().chapterErrors.book).toContain("chapter failure");
    expect(store.getSnapshot().chapters.book.latest).toBe("目录读取失败");
    expect(store.getSnapshot().loading).toBe(false);
  });
});

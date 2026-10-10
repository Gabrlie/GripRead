import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryStore, orderBooks } from "./library";
import { SettingsStore } from "./settings";
import type { LibraryService } from "../services/contracts";
import type {
  ImportResult,
  ImportStatus,
  LibraryBook,
  ReaderPreferences,
} from "../types/generated";
import { DEFAULT_READING_STYLE } from "../types/generated";
const library = (): LibraryService => ({
  pickAndImportTxt: vi.fn(async () => null),
  startImport: vi.fn(async () => ({ operationId: "op" })),
  getImportStatus: vi.fn(),
  cancelImport: vi.fn(async () => ({ requested: true })),
  listGroups: vi.fn(async () => []),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  deleteGroup: vi.fn(),
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
  restoreBook: vi.fn(),
  listBooks: vi.fn(async () => []),
  onImportProgress: vi.fn(async () => () => {}),
  startTxtDecode: vi.fn(),
  getTxtDecodeStatus: vi.fn(),
  cancelTxtDecode: vi.fn(async () => ({ requested: true })),
  onTxtDecodeProgress: vi.fn(async () => () => {}),
  getBookInfo: vi.fn(),
  getTxtEncoding: vi.fn(),
  pickAndReassociateTxt: vi.fn(async () => null),
  reassociateTxtSource: vi.fn(),
});
const preferences: ReaderPreferences = {
  theme: "system",
  paperTone: "warm-tea",
  oledBlack: false,
  fontSize: 20,
  lineHeight: 1.8,
  fontFamily: "serif",
  pageTurnEffect: "curl",
  autoPageSeconds: 8,
  readingMode: "single",
  autoScrollSpeed: 40,
  style: DEFAULT_READING_STYLE,
};
const book = (
  id: string,
  title: string,
  createdAt: number,
  lastReadAt: number | null,
): LibraryBook => ({
  book: { id, title, author: null, contentVersion: `v-${id}`, createdAt, updatedAt: createdAt },
  asset: {
    id: `asset-${id}`,
    bookId: id,
    kind: "txt",
    sha256: `hash-${id}`,
    byteLength: 1,
    contentVersion: `v-${id}`,
    availability: "ready",
    createdAt,
  },
  locator: null,
  totalLength: 1,
  txtEncoding: null,
  lastReadAt,
  removedAt: null,
  shelfState: null,
  coverAssetId: null,
  useReplaceRules: true,
});
afterEach(() => vi.useRealTimers());
describe("application-owned import", () => {
  it("expires success feedback without losing the result or refreshing twice", async () => {
    vi.useFakeTimers();
    const service = library();
    let notify!: (status: ImportStatus) => void;
    vi.mocked(service.onImportProgress).mockImplementation(async (listener) => {
      notify = listener;
      return () => {};
    });
    const entry = book("imported", "导入的书", 1, null);
    const completed: ImportStatus = {
      operationId: "op",
      phase: "completed",
      bytesRead: 1,
      totalBytes: 1,
      result: {
        book: entry.book,
        asset: entry.asset,
        duplicate: false,
        sourceByteLength: 1,
      },
      error: null,
    };
    vi.mocked(service.getImportStatus).mockResolvedValue(completed);
    vi.mocked(service.listBooks).mockResolvedValue([entry]);
    const store = new LibraryStore(service);
    const disconnect = store.connect();
    await store.importTxt("/book.txt");
    expect(store.getSnapshot().importNotice?.phase).toBe("completed");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(store.getSnapshot().importNotice).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot()).toMatchObject({
      books: [entry],
      importing: false,
      importNotice: null,
      importOutcome: { phase: "completed", status: completed },
    });
    notify(completed);
    expect(store.getSnapshot().importNotice).toBeNull();
    expect(service.listBooks).toHaveBeenCalledTimes(2);
    expect(service.listRemovedBooks).toHaveBeenCalledTimes(1);
    disconnect();
  });
  it("pauses feedback for interaction and resumes its remaining lifetime", async () => {
    vi.useFakeTimers();
    const service = library();
    vi.mocked(service.startImport).mockRejectedValue(new Error("disk unavailable"));
    const store = new LibraryStore(service);
    await store.importTxt("/book.txt");
    const id = store.getSnapshot().importNotice!.id;
    await vi.advanceTimersByTimeAsync(2_000);
    store.pauseImportNotice(id);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.getSnapshot().importNotice?.id).toBe(id);
    store.resumeImportNotice(id);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(store.getSnapshot().importNotice?.id).toBe(id);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot()).toMatchObject({
      importNotice: null,
      importOutcome: { phase: "failed", error: "Error: disk unavailable" },
    });
    store.requestImportDetails();
    expect(store.getSnapshot().importDetailsRequested).toBe(true);
  });
  it("keeps a newer notice alive when an older timeout or dismissal arrives", async () => {
    vi.useFakeTimers();
    const service = library();
    vi.mocked(service.startImport).mockRejectedValue(new Error("disk unavailable"));
    const store = new LibraryStore(service);
    await store.importTxt("/first.txt");
    const firstId = store.getSnapshot().importNotice!.id;
    await vi.advanceTimersByTimeAsync(7_000);
    await store.importTxt("/second.txt");
    const secondId = store.getSnapshot().importNotice!.id;
    store.dismissImportNotice(firstId);
    store.pauseImportNotice(firstId);
    store.resumeImportNotice(firstId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getSnapshot().importNotice?.id).toBe(secondId);
    store.dismissImportNotice(secondId);
    expect(store.getSnapshot()).toMatchObject({
      importNotice: null,
      importOutcome: { phase: "failed" },
    });
    expect(service.cancelImport).not.toHaveBeenCalled();
  });
  it("keeps picker cancellation silent and retains the last failed outcome", async () => {
    vi.useFakeTimers();
    const service = library();
    const store = new LibraryStore(service);
    await store.importTxt();
    expect(store.getSnapshot()).toMatchObject({
      importing: false,
      importError: null,
      importOutcome: null,
      importNotice: null,
    });
    vi.mocked(service.startImport).mockRejectedValue(new Error("disk unavailable"));
    await store.importTxt("/book.txt");
    const outcome = store.getSnapshot().importOutcome;
    await store.importTxt();
    expect(store.getSnapshot()).toMatchObject({
      importing: false,
      importError: null,
      job: null,
      importOutcome: outcome,
      importNotice: null,
    });
  });
  it("ignores a cancellation failure after its job has finished and a new one starts", async () => {
    vi.useFakeTimers();
    const service = library();
    let notify!: (status: ImportStatus) => void;
    let rejectCancel!: (error: Error) => void;
    vi.mocked(service.onImportProgress).mockImplementation(async (listener) => {
      notify = listener;
      return () => {};
    });
    vi.mocked(service.cancelImport).mockImplementation(
      () => new Promise((_, reject) => (rejectCancel = reject)),
    );
    vi.mocked(service.startImport)
      .mockResolvedValueOnce({ operationId: "old" })
      .mockResolvedValueOnce({ operationId: "new" });
    const progress: ImportStatus = {
      operationId: "old",
      phase: "reading",
      bytesRead: 1,
      totalBytes: 10,
      result: null,
      error: null,
    };
    vi.mocked(service.getImportStatus).mockImplementation(async (operationId) => ({
      ...progress,
      operationId,
    }));
    const store = new LibraryStore(service);
    const disconnect = store.connect();
    await store.importTxt("/first.txt");
    const cancellation = store.cancel();
    notify({ ...progress, phase: "cancelled" });
    await store.importTxt("/second.txt");
    rejectCancel(new Error("late cancellation failure"));
    await cancellation;
    expect(store.getSnapshot()).toMatchObject({
      importing: true,
      importError: null,
      job: { operationId: "new", phase: "reading" },
      importNotice: null,
    });
    disconnect();
  });
  it("ignores late polling failures and repeated terminal events from an older job", async () => {
    vi.useFakeTimers();
    const service = library();
    let notify!: (status: ImportStatus) => void;
    let rejectOld!: (error: Error) => void;
    vi.mocked(service.onImportProgress).mockImplementation(async (listener) => {
      notify = listener;
      return () => {};
    });
    vi.mocked(service.startImport)
      .mockResolvedValueOnce({ operationId: "old" })
      .mockResolvedValueOnce({ operationId: "new" });
    const progress: ImportStatus = {
      operationId: "new",
      phase: "reading",
      bytesRead: 1,
      totalBytes: 9,
      result: null,
      error: null,
    };
    vi.mocked(service.getImportStatus)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValue(progress);
    const store = new LibraryStore(service);
    const disconnect = store.connect();
    const pending = store.importTxt("first.txt");
    await Promise.resolve();
    const cancelled: ImportStatus = { ...progress, operationId: "old", phase: "cancelled" };
    notify(cancelled);
    await store.importTxt("second.txt");
    notify(cancelled);
    rejectOld(new Error("late failure"));
    await pending;
    expect(store.getSnapshot()).toMatchObject({
      job: progress,
      importing: true,
      importError: null,
    });
    disconnect();
  });
  it("never creates a synthetic book on a failed import", async () => {
    const service = library();
    vi.mocked(service.startImport).mockRejectedValue(new Error("bridge failed"));
    const store = new LibraryStore(service);
    await store.importTxt("/book.txt");
    expect(store.getSnapshot().books).toEqual([]);
    expect(store.getSnapshot().importError).toContain("bridge failed");
    expect(store.getSnapshot().importing).toBe(false);
  });
  it("keeps cancellation pending until the backend reports terminal state", async () => {
    vi.useFakeTimers();
    const service = library();
    const progress: ImportStatus = {
      operationId: "op",
      phase: "reading",
      bytesRead: 0,
      totalBytes: 10,
      result: null,
      error: null,
    };
    vi.mocked(service.getImportStatus)
      .mockResolvedValueOnce(progress)
      .mockResolvedValueOnce({
        ...progress,
        phase: "cancelled",
        error: { code: "import_cancelled", message: "cancelled" },
      });
    const store = new LibraryStore(service);
    await store.importTxt("/book.txt");
    await store.cancel();
    expect(store.getSnapshot().importing).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(store.getSnapshot().job?.phase).toBe("cancelled");
    expect(store.getSnapshot().importing).toBe(false);
  });
  it("turns a malformed completed status into an observable failure", async () => {
    const service = library();
    vi.mocked(service.getImportStatus).mockResolvedValueOnce({
      operationId: "op",
      phase: "completed",
      bytesRead: 10,
      totalBytes: 10,
      result: null,
      error: null,
    });
    const store = new LibraryStore(service);
    await store.importTxt("/book.txt");
    expect(store.getSnapshot()).toMatchObject({
      importing: false,
      job: { phase: "failed", result: null, error: { code: "io" } },
    });
    expect(store.getSnapshot().importError).toContain("缺少结果");
  });
  it("accepts an empty library snapshot and reports failures", async () => {
    const service = library();
    const store = new LibraryStore(service);
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ books: [], loading: false, error: null });
    vi.mocked(service.listBooks).mockRejectedValueOnce(new Error("database unavailable"));
    await store.refresh();
    expect(store.getSnapshot().error).toContain("database unavailable");
  });
  it("keeps removed-book loading distinct from a confirmed empty archive", async () => {
    let resolve!: (books: LibraryBook[]) => void;
    const service = library();
    vi.mocked(service.listRemovedBooks).mockReturnValue(
      new Promise<LibraryBook[]>((res) => {
        resolve = res;
      }),
    );
    const store = new LibraryStore(service);
    const pending = store.loadRemoved();
    expect(store.getSnapshot()).toMatchObject({ removedLoading: true, removedLoaded: false });
    resolve([]);
    await pending;
    expect(store.getSnapshot()).toMatchObject({
      removedLoading: false,
      removedLoaded: true,
      removedBooks: [],
    });
  });
  it("queues shelf mutations, refreshes both views, and keeps failures visible", async () => {
    const service = library();
    const entry = book("book", "标题", 1, null);
    vi.mocked(service.listBooks).mockResolvedValue([entry]);
    vi.mocked(service.listRemovedBooks).mockResolvedValue([]);
    const store = new LibraryStore(service);
    await store.refresh();
    await store.remove(entry);
    expect(service.removeBook).toHaveBeenCalledWith("book");
    expect(store.getSnapshot()).toMatchObject({
      lastRemoved: { id: "book", title: "标题" },
      managing: false,
      managementError: null,
    });
    vi.mocked(service.updateBook).mockRejectedValueOnce(new Error("metadata unavailable"));
    await expect(store.edit({ bookId: "book", title: "新标题", author: null })).rejects.toThrow(
      "metadata unavailable",
    );
    expect(store.getSnapshot().managementError).toContain("metadata unavailable");
  });
  it("does not leave a stale refresh spinner after a failed mutation", async () => {
    let release!: (books: LibraryBook[]) => void;
    const service = library();
    vi.mocked(service.listBooks).mockReturnValue(
      new Promise<LibraryBook[]>((resolve) => {
        release = resolve;
      }),
    );
    vi.mocked(service.removeBook).mockRejectedValueOnce(new Error("archive unavailable"));
    const store = new LibraryStore(service);
    const refresh = store.refresh();
    const pending = store.remove(book("book", "标题", 1, null));
    await expect(pending).rejects.toThrow("archive unavailable");
    expect(store.getSnapshot()).toMatchObject({ loading: false, managing: false });
    release([]);
    await refresh;
  });
  it("clears the undo banner when a duplicate import restores an archived book", async () => {
    const service = library();
    const entry = book("book", "标题", 1, null);
    const result: ImportResult = {
      book: entry.book,
      asset: entry.asset,
      duplicate: true,
      sourceByteLength: entry.asset.byteLength,
    };
    vi.mocked(service.listBooks).mockResolvedValue([entry]);
    vi.mocked(service.listRemovedBooks).mockResolvedValue([entry]);
    vi.mocked(service.startImport).mockResolvedValue({ operationId: "restore-import" });
    vi.mocked(service.getImportStatus).mockResolvedValue({
      operationId: "restore-import",
      phase: "completed",
      bytesRead: 1,
      totalBytes: 1,
      result,
      error: null,
    });
    const store = new LibraryStore(service);
    await store.refresh();
    await store.remove(entry);
    expect(store.getSnapshot().lastRemoved).toEqual({ id: "book", title: "标题" });
    await store.importTxt("/book.txt");
    expect(store.getSnapshot().lastRemoved).toBeNull();
    expect(service.listRemovedBooks).toHaveBeenCalled();
  });
});
describe("shelf ordering", () => {
  const entries = [
    book("old", "第 10 章", 1, null),
    book("recent", "第 2 章", 2, 30),
    book("middle", "第 1 章", 3, 20),
  ];
  it("uses persisted recent, imported, and natural title ordering", () => {
    expect(orderBooks(entries, "recent_read").map((entry) => entry.book.id)).toEqual([
      "recent",
      "middle",
      "old",
    ]);
    expect(orderBooks(entries, "imported").map((entry) => entry.book.id)).toEqual([
      "middle",
      "recent",
      "old",
    ]);
    expect(orderBooks(entries, "title").map((entry) => entry.book.id)).toEqual([
      "middle",
      "recent",
      "old",
    ]);
  });
});
describe("durable settings", () => {
  it("serializes saves and keeps the newest preference update", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const save = vi
      .fn()
      .mockImplementationOnce(async (value: ReaderPreferences) => {
        await gate;
        return value;
      })
      .mockImplementation(async (value: ReaderPreferences) => value);
    const store = new SettingsStore({ getSettings: async () => preferences, saveSettings: save });
    await store.load();
    store.set({ fontSize: 22 });
    store.set({ lineHeight: 2 });
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await store.flush();
    expect(save).toHaveBeenLastCalledWith({ ...preferences, fontSize: 22, lineHeight: 2 });
  });
  it("exposes failed persistence and retries the unsaved value", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(async (value: ReaderPreferences) => value);
    const store = new SettingsStore({ getSettings: async () => preferences, saveSettings: save });
    await store.load();
    store.set({ fontSize: 24 });
    await expect(store.flush()).rejects.toThrow("disk full");
    expect(store.getSnapshot().error).toContain("disk full");
    store.retry();
    await store.flush();
    expect(store.getSnapshot().error).toBeNull();
    expect(save).toHaveBeenLastCalledWith({ ...preferences, fontSize: 24 });
  });
  it("does not let a stale reload overwrite a write that started after it", async () => {
    let resolveReload!: (value: ReaderPreferences) => void;
    const getSettings = vi
      .fn<() => Promise<ReaderPreferences>>()
      .mockResolvedValueOnce(preferences)
      .mockReturnValueOnce(
        new Promise<ReaderPreferences>((resolve) => {
          resolveReload = resolve;
        }),
      );
    const save = vi.fn(async (value: ReaderPreferences) => value);
    const store = new SettingsStore({ getSettings, saveSettings: save });
    await store.load();
    const reload = store.load();
    store.set({ fontSize: 24 });
    resolveReload(preferences);
    await reload;
    await store.flush();
    expect(store.getSnapshot().value?.fontSize).toBe(24);
    expect(save).toHaveBeenLastCalledWith({ ...preferences, fontSize: 24 });
  });
  it("previews immediately and coalesces delayed writes until adjustments stop", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async (value: ReaderPreferences) => value);
      const store = new SettingsStore(
        { getSettings: async () => preferences, saveSettings: save },
        800,
      );
      await store.load();
      store.set({ fontSize: 20 });
      vi.advanceTimersByTime(500);
      store.set({ fontSize: 21 });
      expect(store.getSnapshot().value?.fontSize).toBe(21);
      vi.advanceTimersByTime(700);
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenLastCalledWith({ ...preferences, fontSize: 21 });
    } finally {
      vi.useRealTimers();
    }
  });
  it("flush writes a delayed value at once and reports failure for retry", async () => {
    vi.useFakeTimers();
    try {
      const save = vi
        .fn()
        .mockRejectedValueOnce(new Error("locked"))
        .mockImplementation(async (value: ReaderPreferences) => value);
      const store = new SettingsStore(
        { getSettings: async () => preferences, saveSettings: save },
        800,
      );
      await store.load();
      store.set({ lineHeight: 2.2 });
      await expect(store.flush()).rejects.toThrow("locked");
      store.set({ fontSize: 26 });
      await store.flush();
      expect(save).toHaveBeenLastCalledWith({ ...preferences, lineHeight: 2.2, fontSize: 26 });
      expect(store.getSnapshot().error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("waits for a new inactivity delay after a slow write completes", async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const save = vi
        .fn()
        .mockImplementationOnce(async (value: ReaderPreferences) => {
          await gate;
          return value;
        })
        .mockImplementation(async (value: ReaderPreferences) => value);
      const store = new SettingsStore(
        { getSettings: async () => preferences, saveSettings: save },
        800,
      );
      await store.load();
      store.set({ fontSize: 20 });
      await vi.advanceTimersByTimeAsync(800);
      expect(save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      store.set({ fontSize: 21 });
      await vi.advanceTimersByTimeAsync(100);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(save).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().saving).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(save).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenLastCalledWith({ ...preferences, fontSize: 21 });
      expect(store.getSnapshot().saving).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("flush does not wait for the delay of an edit made during a slow write", async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const save = vi
        .fn()
        .mockImplementationOnce(async (value: ReaderPreferences) => {
          await gate;
          return value;
        })
        .mockImplementation(async (value: ReaderPreferences) => value);
      const store = new SettingsStore(
        { getSettings: async () => preferences, saveSettings: save },
        800,
      );
      await store.load();
      store.set({ fontSize: 20 });
      await vi.advanceTimersByTimeAsync(800);
      store.set({ fontSize: 21 });
      const flushed = store.flush();
      release();
      await flushed;
      expect(save).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenLastCalledWith({ ...preferences, fontSize: 21 });
      await vi.advanceTimersByTimeAsync(800);
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

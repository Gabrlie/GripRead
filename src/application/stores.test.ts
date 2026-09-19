import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryStore } from "./library";
import { SettingsStore } from "./settings";
import type { LibraryService } from "../services/contracts";
import type { ImportStatus, ReaderPreferences } from "../types/generated";
const library = (): LibraryService => ({
  pickAndImportTxt: vi.fn(async () => null),
  startImport: vi.fn(async () => ({ operationId: "op" })),
  getImportStatus: vi.fn(),
  cancelImport: vi.fn(async () => ({ requested: true })),
  listGroups: vi.fn(async () => []),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  deleteGroup: vi.fn(),
  setBookGroups: vi.fn(),
  listBooks: vi.fn(async () => []),
  onImportProgress: vi.fn(async () => () => {}),
  startTxtDecode: vi.fn(),
  getTxtDecodeStatus: vi.fn(),
  cancelTxtDecode: vi.fn(async () => ({ requested: true })),
  onTxtDecodeProgress: vi.fn(async () => () => {}),
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
};
afterEach(() => vi.useRealTimers());
describe("application-owned import", () => {
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
});

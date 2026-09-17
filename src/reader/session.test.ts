import { describe, expect, it } from "vitest";

import type {
  Book,
  CancelResult,
  ContentWindow,
  ImportStatus,
  ImportTask,
  ReaderLocator,
} from "../types/generated";
import type { ReaderService } from "../services/ipc";
import { ReaderSession } from "./session";

const locator = (offset: number): ReaderLocator => ({
  bookId: "book",
  contentVersion: "v1",
  resourceId: "asset",
  offset,
  contextBefore: "",
  contextAfter: "",
});

const windowAt = (start: number, end: number, text: string, hasAfter: boolean): ContentWindow => ({
  bookId: "book",
  resourceId: "asset",
  contentVersion: "v1",
  text,
  startOffset: start,
  endOffset: end,
  totalLength: 4,
  hasBefore: start > 0,
  hasAfter,
  locator: locator(start),
});

function serviceFor(readContentWindow: ReaderService["readContentWindow"]): ReaderService {
  const noTask: ImportTask = { operationId: "unused" };
  const noCancel: CancelResult = { requested: false };
  const noBook: Book[] = [];
  const noStatus = {} as ImportStatus;
  return {
    startImport: async () => noTask,
    getImportStatus: async () => noStatus,
    cancelImport: async () => noCancel,
    listBooks: async () => noBook,
    readContentWindow,
    saveReaderLocator: async (position) => position,
    getSavedReaderLocator: async () => null,
    onImportProgress: async () => () => undefined,
  };
}

describe("ReaderSession", () => {
  it("turns forward, saves the active locator, and returns to history", async () => {
    const service = serviceFor(async (_bookId, position) =>
      position?.offset === 2 ? windowAt(2, 4, "cd", false) : windowAt(0, 2, "ab", true),
    );
    const session = new ReaderSession(service);

    await session.open("book", 2);
    const next = await session.turn("next", 2);
    expect(next?.text).toBe("cd");
    expect(await session.save()).toEqual(locator(2));
    expect((await session.turn("previous", 2))?.text).toBe("ab");
  });

  it("rejects a late next response after a previous turn supersedes it", async () => {
    let resolveNext: ((value: ContentWindow) => void) | undefined;
    const pendingNext = new Promise<ContentWindow>((resolve) => {
      resolveNext = resolve;
    });
    let call = 0;
    const service = serviceFor(async () => {
      call += 1;
      return call === 1 ? windowAt(0, 2, "ab", true) : pendingNext;
    });
    const session = new ReaderSession(service);
    await session.open("book", 2);

    const next = session.turn("next", 2);
    expect(await session.turn("previous", 2)).toEqual(session.current);
    resolveNext?.(windowAt(2, 4, "cd", false));
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(session.current?.text).toBe("ab");
  });
});

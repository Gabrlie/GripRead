import { describe, expect, it, vi } from "vitest";

import type { ReaderService } from "../services/contracts";
import type { ContentWindow, ReadContentRequest, ReaderLocator } from "../types/generated";
import { paginateText } from "./pagination";
import type { ReaderPage } from "./pagination";
import { ReaderController, ReaderProtocolError } from "./controller";
import type {
  ReaderDisplayedPage,
  ReaderPresentationAdapter,
  ReaderPresentationContext,
} from "./types";

const locatorFor = (bookId: string, offset: number): ReaderLocator => ({
  bookId,
  contentVersion: `version-${bookId}`,
  resourceId: `resource-${bookId}`,
  offset,
  contextBefore: "",
  contextAfter: "",
});

function windowFor(bookId: string, content: string, start: number, end: number): ContentWindow {
  const locator = locatorFor(bookId, start);
  return {
    bookId,
    resourceId: locator.resourceId,
    contentVersion: locator.contentVersion,
    text: content.slice(start, end),
    startOffset: start,
    endOffset: end,
    totalLength: content.length,
    hasBefore: start > 0,
    hasAfter: end < content.length,
    locator,
  };
}

function serviceFor(
  contents: Record<string, string>,
  saved: Record<string, ReaderLocator | null> = {},
  onSave: (locator: ReaderLocator) => Promise<ReaderLocator> = async (value) => value,
): ReaderService & { requests: ReadContentRequest[]; saves: ReaderLocator[] } {
  const requests: ReadContentRequest[] = [];
  const saves: ReaderLocator[] = [];
  return {
    requests,
    saves,
    async readContentWindow(request) {
      requests.push(request);
      const content = contents[request.bookId];
      if (content === undefined) throw new Error(`unknown book ${request.bookId}`);
      const anchor =
        request.locator?.offset ?? (request.direction === "backward" ? content.length : 0);
      const start =
        request.direction === "backward" ? Math.max(0, anchor - request.maxUnits) : anchor;
      const end =
        request.direction === "backward"
          ? anchor
          : Math.min(content.length, anchor + request.maxUnits);
      return windowFor(request.bookId, content, start, end);
    },
    async resolveLocator(bookId, progress) {
      const content = contents[bookId];
      if (content === undefined) throw new Error(`unknown book ${bookId}`);
      return locatorFor(bookId, Math.floor(content.length * progress));
    },
    async saveReaderLocator(value) {
      saves.push({ ...value });
      return onSave(value);
    },
    async getSavedReaderLocator(bookId) {
      return saved[bookId] ?? null;
    },
  };
}

function wholeWindowMeasurer(window: ContentWindow): ReaderPage[] {
  return window.text.length === 0
    ? []
    : paginateText(window.text, window.startOffset, window.text.length);
}

function oneUnitMeasurer(window: ContentWindow): ReaderPage[] {
  return window.text.length === 0 ? [] : paginateText(window.text, window.startOffset, 1);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function adapterSpy(): ReaderPresentationAdapter & {
  pages: readonly ReaderDisplayedPage[];
  presentations: Array<{
    page: ReaderDisplayedPage;
    direction: string;
    context: ReaderPresentationContext;
  }>;
} {
  const state = {
    pages: [] as readonly ReaderDisplayedPage[],
    presentations: [] as Array<{
      page: ReaderDisplayedPage;
      direction: string;
      context: ReaderPresentationContext;
    }>,
  };
  return {
    ...state,
    setPages(pages) {
      state.pages = pages;
    },
    present(page, direction, context) {
      state.presentations.push({ page, direction, context });
    },
    get pages() {
      return state.pages;
    },
    get presentations() {
      return state.presentations;
    },
  };
}

describe("ReaderController", () => {
  it("loads bounded windows, turns across their boundary, and saves the current locator", async () => {
    const service = serviceFor({ book: "abcdef" });
    const adapter = adapterSpy();
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
      maxUnits: 3,
      adapter,
    });

    await controller.open("book");
    expect(controller.getSnapshot().page?.text).toBe("abc");
    await controller.next();
    expect(controller.getSnapshot().page?.text).toBe("def");
    await controller.previous();
    expect(controller.getSnapshot().page?.text).toBe("abc");
    await controller.flush();

    expect(
      service.requests.map(({ direction, locator }) => [direction, locator?.offset ?? null]),
    ).toEqual([
      ["forward", null],
      ["forward", 3],
    ]);
    expect(service.saves.at(-1)?.offset).toBe(0);
    expect(adapter.presentations.map(({ direction }) => direction)).toEqual([
      "open",
      "next",
      "previous",
    ]);
  });

  it("reads backward at EOF so an end locator still has a visible last page", async () => {
    const service = serviceFor({ book: "abcdef" }, { book: locatorFor("book", 6) });
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
      maxUnits: 3,
    });

    await controller.open("book");

    expect(controller.getSnapshot()).toMatchObject({
      page: expect.objectContaining({ text: "def", startOffset: 3, endOffset: 6 }),
      pageCount: 1,
      hasBefore: true,
      hasAfter: false,
    });
    expect(service.requests.map(({ direction }) => direction)).toEqual(["forward", "backward"]);
  });

  it("seeks progress to EOF and loads the preceding window on previous", async () => {
    const service = serviceFor({ book: "abcdef" });
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
      maxUnits: 3,
    });

    await controller.open("book");
    await controller.seekProgress(1);

    expect(controller.getSnapshot().page).toMatchObject({
      text: "def",
      startOffset: 3,
      endOffset: 6,
      hasAfter: false,
    });
    expect(
      service.requests.map(({ direction, locator }) => [direction, locator?.offset ?? null]),
    ).toEqual([
      ["forward", null],
      ["forward", 6],
      ["backward", 6],
    ]);

    await controller.previous();

    expect(controller.getSnapshot().page).toMatchObject({
      text: "abc",
      startOffset: 0,
      endOffset: 3,
      hasBefore: false,
    });
    expect(service.requests.at(-1)).toMatchObject({
      direction: "backward",
      locator: expect.objectContaining({ offset: 3 }),
    });
  });

  it("keeps an empty content window available to the view", async () => {
    const service = serviceFor({ book: "" });
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
    });

    await controller.open("book");

    expect(controller.getSnapshot()).toMatchObject({
      page: null,
      pageCount: 0,
      contentWindow: expect.objectContaining({ totalLength: 0, text: "" }),
      hasBefore: false,
      hasAfter: false,
    });
  });

  it("waits for the old save before opening a new book without clobbering its state", async () => {
    let releaseSave: (() => void) | undefined;
    const saveStarted = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const service = serviceFor({ first: "first", second: "second" }, {}, async (value) => {
      if (value.bookId === "first") {
        await saveStarted;
        throw new Error("old save failed");
      }
      return value;
    });
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
      maxUnits: 20,
    });

    await controller.open("first");
    const opening = controller.open("second");
    await Promise.resolve();
    expect(service.requests).toHaveLength(1);
    releaseSave?.();
    await expect(opening).rejects.toMatchObject({ name: "ReaderSaveError" });
    expect(controller.getSnapshot()).toMatchObject({
      bookId: "second",
      page: expect.objectContaining({ text: "second" }),
      error: null,
      saveError: null,
    });
    expect(service.requests.at(-1)?.bookId).toBe("second");
  });

  it("rejects a response that does not honor the requested book and anchor", async () => {
    const wrongBook = windowFor("another-book", "abcdef", 0, 3);
    const service = serviceFor({ book: "abcdef" });
    vi.spyOn(service, "readContentWindow").mockResolvedValueOnce(wrongBook);
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
    });

    await expect(controller.open("book")).rejects.toBeInstanceOf(ReaderProtocolError);
    expect(controller.getSnapshot()).toMatchObject({
      error: "content window belongs to another book",
      page: null,
    });
  });

  it("rejects a saved locator that belongs to another book", async () => {
    const service = serviceFor({ book: "abcdef" });
    vi.spyOn(service, "getSavedReaderLocator").mockResolvedValueOnce(locatorFor("other", 0));
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
    });

    await expect(controller.open("book")).rejects.toMatchObject({
      name: "ReaderProtocolError",
      message: "reader locator belongs to another book",
    });
    expect(controller.getSnapshot()).toMatchObject({
      error: "reader locator belongs to another book",
    });
  });

  it("rejects an empty window in the middle of a non-empty book", async () => {
    const service = serviceFor({ book: "abcdef" });
    vi.spyOn(service, "readContentWindow").mockResolvedValueOnce(windowFor("book", "abcdef", 0, 0));
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
    });

    await expect(controller.open("book")).rejects.toMatchObject({
      name: "ReaderProtocolError",
      message: "non-empty content windows cannot be empty",
    });
    expect(controller.getSnapshot()).toMatchObject({
      error: "non-empty content windows cannot be empty",
      page: null,
    });
  });

  it("serializes rapid next calls and commits both turns in order", async () => {
    const service = serviceFor({ book: "abcd" });
    const adapter = adapterSpy();
    const controller = new ReaderController(service, {
      measurer: { measure: oneUnitMeasurer },
      maxUnits: 4,
      adapter,
    });

    await controller.open("book");
    await Promise.all([controller.next(), controller.next()]);

    expect(controller.getSnapshot().page).toMatchObject({ text: "c", startOffset: 2 });
    expect(adapter.presentations.map(({ direction, page }) => [direction, page.text])).toEqual([
      ["open", "a"],
      ["next", "b"],
      ["next", "c"],
    ]);
  });

  it("drops a stale open response before it can replace the newer book", async () => {
    const service = serviceFor({ first: "first", second: "second" });
    const firstReadStarted = deferred<void>();
    const releaseFirstRead = deferred<void>();
    const readContentWindow = service.readContentWindow.bind(service);
    vi.spyOn(service, "readContentWindow").mockImplementation(async (request) => {
      if (request.bookId === "first") {
        firstReadStarted.resolve();
        await releaseFirstRead.promise;
      }
      return readContentWindow(request);
    });
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
    });

    const firstOpen = controller.open("first");
    await firstReadStarted.promise;
    const secondOpen = controller.open("second");
    releaseFirstRead.resolve();

    await expect(firstOpen).rejects.toMatchObject({ name: "AbortError" });
    await expect(secondOpen).resolves.toBeUndefined();
    expect(controller.getSnapshot()).toMatchObject({
      bookId: "second",
      page: expect.objectContaining({ text: "second" }),
      error: null,
    });
  });

  it("drops stale seek responses and keeps the latest requested locator", async () => {
    const service = serviceFor({ book: "abcdef" });
    const firstReadStarted = deferred<void>();
    const releaseFirstRead = deferred<void>();
    const secondReadStarted = deferred<void>();
    const releaseSecondRead = deferred<void>();
    const readContentWindow = service.readContentWindow.bind(service);
    let seekReadCount = 0;
    vi.spyOn(service, "readContentWindow").mockImplementation(async (request) => {
      if (request.locator) {
        seekReadCount += 1;
        if (seekReadCount === 1) {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        } else if (seekReadCount === 2) {
          secondReadStarted.resolve();
          await releaseSecondRead.promise;
        }
      }
      return readContentWindow(request);
    });
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
      maxUnits: 10,
    });

    await controller.open("book");
    await controller.flush();
    const firstSeek = controller.seek(locatorFor("book", 2));
    await firstReadStarted.promise;
    const secondSeek = controller.seek(locatorFor("book", 4));
    releaseFirstRead.resolve();
    await secondReadStarted.promise;
    releaseSecondRead.resolve();

    await expect(firstSeek).rejects.toMatchObject({ name: "AbortError" });
    await expect(secondSeek).resolves.toBeUndefined();
    expect(controller.getSnapshot().page).toMatchObject({ text: "ef", startOffset: 4 });
  });

  it("drops a stale service failure without exposing it as the current error", async () => {
    const service = serviceFor({ book: "abcdef" });
    const firstReadStarted = deferred<void>();
    const rejectFirstRead = deferred<void>();
    const secondReadStarted = deferred<void>();
    const releaseSecondRead = deferred<void>();
    const readContentWindow = service.readContentWindow.bind(service);
    let seekReadCount = 0;
    vi.spyOn(service, "readContentWindow").mockImplementation(async (request) => {
      if (request.locator) {
        seekReadCount += 1;
        if (seekReadCount === 1) {
          firstReadStarted.resolve();
          await rejectFirstRead.promise;
        } else if (seekReadCount === 2) {
          secondReadStarted.resolve();
          await releaseSecondRead.promise;
        }
      }
      return readContentWindow(request);
    });
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
      maxUnits: 10,
    });

    await controller.open("book");
    const firstSeek = controller.seek(locatorFor("book", 2));
    await firstReadStarted.promise;
    const secondSeek = controller.seek(locatorFor("book", 4));
    rejectFirstRead.reject(new Error("stale read failed"));
    await secondReadStarted.promise;
    releaseSecondRead.resolve();

    await expect(firstSeek).rejects.toMatchObject({ name: "AbortError" });
    await expect(secondSeek).resolves.toBeUndefined();
    expect(controller.getSnapshot()).toMatchObject({
      page: expect.objectContaining({ text: "ef", startOffset: 4 }),
      error: null,
    });
  });

  it("drops stale reflow responses and commits the latest layout", async () => {
    const service = serviceFor({ book: "abcdef" });
    const firstReadStarted = deferred<void>();
    const releaseFirstRead = deferred<void>();
    const secondReadStarted = deferred<void>();
    const releaseSecondRead = deferred<void>();
    const readContentWindow = service.readContentWindow.bind(service);
    let reflowReadCount = 0;
    vi.spyOn(service, "readContentWindow").mockImplementation(async (request) => {
      if (request.locator?.offset === 0) {
        reflowReadCount += 1;
        if (reflowReadCount === 1) {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        } else if (reflowReadCount === 2) {
          secondReadStarted.resolve();
          await releaseSecondRead.promise;
        }
      }
      return readContentWindow(request);
    });
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
      maxUnits: 10,
    });

    await controller.open("book");
    await controller.flush();
    const firstReflow = controller.reflow();
    await firstReadStarted.promise;
    const secondReflow = controller.reflow();
    releaseFirstRead.resolve();
    await secondReadStarted.promise;
    releaseSecondRead.resolve();

    await expect(firstReflow).rejects.toMatchObject({ name: "AbortError" });
    await expect(secondReflow).resolves.toBeUndefined();
    expect(controller.getSnapshot().page).toMatchObject({ text: "abcdef", startOffset: 0 });
  });

  it("coalesces pending saves to the latest locator while an earlier save is slow", async () => {
    const firstSaveStarted = deferred<void>();
    const releaseFirstSave = deferred<void>();
    let saveCount = 0;
    const service = serviceFor({ book: "abcd" }, {}, async (locator) => {
      saveCount += 1;
      if (saveCount === 1) {
        firstSaveStarted.resolve();
        await releaseFirstSave.promise;
      }
      return locator;
    });
    const controller = new ReaderController(service, {
      measurer: { measure: oneUnitMeasurer },
      maxUnits: 4,
    });

    await controller.open("book");
    await firstSaveStarted.promise;
    await Promise.all([controller.next(), controller.next()]);
    expect(service.saves.map(({ offset }) => offset)).toEqual([0]);

    releaseFirstSave.resolve();
    await controller.flush();
    expect(service.saves.map(({ offset }) => offset)).toEqual([0, 2]);
  });

  it("retries a failed save during flush and clears its visible error", async () => {
    let attempts = 0;
    const service = serviceFor({ book: "book" }, {}, async (locator) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary save failure");
      return locator;
    });
    const controller = new ReaderController(service, {
      measurer: { measure: wholeWindowMeasurer },
    });

    await controller.open("book");
    await controller.flush();

    expect(attempts).toBe(2);
    expect(service.saves.map(({ offset }) => offset)).toEqual([0, 0]);
    expect(controller.getSnapshot().saveError).toBeNull();
  });
});

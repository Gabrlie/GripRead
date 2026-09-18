import { browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";

import {
  LARGE_WINDOW_UNITS,
  clickReaderControl,
  clickSaveControl,
  expectUtf16Window,
  importFixture,
  dataPath,
  invoke,
  listBooks,
  normalizedFixture,
  openBook,
  readPage,
  refreshLibraryInUi,
  waitForAppReady,
  waitForNextPage,
  waitForPageStart,
  useInstantPageTurns,
} from "./support";
import type { ContentWindow, ImportResult } from "../../src/types/generated";

describe("GripRead native M0 acceptance", () => {
  let mixed: ImportResult;
  let large: ImportResult;
  let mixedText: string;
  let largeText: string;

  before(async () => {
    await waitForAppReady();
    await useInstantPageTurns();
    mixedText = await normalizedFixture("mixed.txt");
    largeText = await normalizedFixture("million.txt");

    mixed = await importFixture("mixed.txt");
    large = await importFixture("million.txt");
    await refreshLibraryInUi(mixed.book.id);
  });

  it("imports real TXT bytes, deduplicates identical normalized content, and reads every UTF-16 window contiguously", async () => {
    const duplicate = await importFixture("mixed-duplicate.txt");
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.book.id).toBe(mixed.book.id);
    expect(duplicate.asset.id).toBe(mixed.asset.id);

    const pieces: string[] = [];
    let locator: unknown = null;
    let expectedStart = 0;
    let windows = 0;
    let current: ContentWindow;
    do {
      current = await invoke<ContentWindow>("read_content_window", {
        request: {
          bookId: large.book.id,
          locator,
          maxUnits: LARGE_WINDOW_UNITS,
          direction: "forward",
        },
      });
      expect(current.bookId).toBe(large.book.id);
      expect(current.startOffset).toBe(expectedStart);
      expectUtf16Window(current, largeText);
      pieces.push(current.text);
      expectedStart = current.endOffset;
      locator = {
        ...current.locator,
        offset: current.endOffset,
        contextBefore: "",
        contextAfter: "",
      };
      windows += 1;
      if (windows > 2_000) throw new Error("million-character reader did not terminate");
    } while (current.hasAfter);

    expect(expectedStart).toBe(largeText.length);
    expect(pieces.join("")).toBe(largeText);
    expect(windows).toBeGreaterThan(1);
  });

  it("renders measured reader pages without dropping or duplicating characters", async () => {
    const first = await openBook(mixed.book.id);
    expect(first.bookId).toBe(mixed.book.id);
    expect(first.total).toBe(mixedText.length);
    expect(first.end).toBeGreaterThan(first.start);
    expect(first.end - first.start).toBe(first.text.length);
    expect(first.text).toBe(mixedText.slice(first.start, first.end));
    expect(first.rectCount).toBeGreaterThan(0);
    expect(first.overflowHeight).toBeLessThanOrEqual(first.clientHeight + 2);

    const second = await (async () => {
      await clickReaderControl("reader-next");
      return waitForNextPage(first);
    })();
    expect(second.bookId).toBe(mixed.book.id);
    expect(second.start).toBe(first.end);
    expect(second.end - second.start).toBe(second.text.length);
    expect(second.text).toBe(mixedText.slice(second.start, second.end));

    await clickReaderControl("reader-previous");
    const returned = await waitForPageStart(first.start);
    expect(returned.text).toBe(first.text);
    expect(returned.end).toBe(first.end);
  });

  it("keeps the UTF-16 locator stable when the native window is resized and reflowed", async () => {
    const beforeResize = await readPage();
    await browser.setWindowSize(760, 680);
    const afterResize = await waitForPageStart(beforeResize.start);
    expect(afterResize.bookId).toBe(beforeResize.bookId);
    expect(afterResize.start).toBe(beforeResize.start);
    expect(afterResize.text).toBe(mixedText.slice(afterResize.start, afterResize.end));
    expect(afterResize.rectCount).toBeGreaterThan(0);

    await browser.setWindowSize(1100, 760);
    const afterRestore = await waitForPageStart(beforeResize.start);
    expect(afterRestore.start).toBe(beforeResize.start);
    expect(afterRestore.text).toBe(mixedText.slice(afterRestore.start, afterRestore.end));
  });

  it("saves the current locator through the reader UI for the subsequent process restart phase", async () => {
    const first = await readPage();
    await clickReaderControl("reader-next");
    const current = await waitForNextPage(first);
    expect(current.start).toBeGreaterThan(first.start);
    await clickSaveControl();
    // Record the expected position from the rendered page and fixture metadata,
    // independently of the persistence command used by the restart phase.
    await writeFile(
      dataPath(".native-expected-locator.json"),
      JSON.stringify({
        bookId: mixed.book.id,
        offset: current.start,
        contentVersion: mixed.book.contentVersion,
      }),
      "utf8",
    );
    await clickReaderControl("reader-close");

    const books = await listBooks();
    expect(books.some((entry) => entry.book.id === mixed.book.id)).toBe(true);
  });
});

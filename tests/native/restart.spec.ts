import { browser, expect } from "@wdio/globals";

import {
  invoke,
  normalizedFixture,
  openBook,
  waitForAppReady,
  clickReaderControl,
  readPage,
  waitForNextPage,
} from "./support";
import type { Book, LibraryBook, ReaderLocator } from "../../src/types/generated";

describe("GripRead native process restart", () => {
  it("restores the saved UTF-16 locator after a fresh native process starts", async () => {
    await waitForAppReady();
    const books = await invoke<LibraryBook[]>("list_books");
    const title = process.env.GRIPREAD_NATIVE_MIXED_TITLE;
    if (!title) throw new Error("GRIPREAD_NATIVE_MIXED_TITLE is required");
    const entry = books.find((candidate) => candidate.book.title === title);
    if (!entry) throw new Error(`Restart fixture book ${title} is missing`);
    const book: Book = entry.book;

    const saved = await invoke<ReaderLocator | null>("get_saved_reader_locator", {
      request: { bookId: book.id },
    });
    if (!saved) throw new Error(`No saved locator exists for ${book.id}`);
    expect(saved.bookId).toBe(book.id);
    expect(saved.offset).toBeGreaterThan(0);

    const expected = await normalizedFixture("mixed.txt");
    const page = await openBook(book.id);
    expect(page.bookId).toBe(book.id);
    expect(page.start).toBe(saved.offset);
    expect(page.end - page.start).toBe(page.text.length);
    expect(page.text).toBe(expected.slice(page.start, page.end));
    await clickReaderControl("reader-previous");
    await browser.waitUntil(async () => (await readPage()).start < page.start);
    const previous = await readPage();
    expect(previous.end).toBe(page.start);
    await clickReaderControl("reader-next");
    const next = await waitForNextPage(previous);
    expect(next.start).toBe(page.start);
  });
});

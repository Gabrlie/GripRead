import { browser, expect } from "@wdio/globals";

import {
  decodeTxt,
  importFixture,
  invoke,
  waitForAppReady,
  refreshLibraryInUi,
  openBook,
  clickReaderControl,
  waitForReaderClosed,
  readPage,
} from "./support";
import type {
  Bookmark,
  ContentWindow,
  ImportResult,
  SearchResponse,
  TocEntry,
  TxtEncodingInfo,
} from "../../src/types/generated";

describe("GripRead native M1 TXT tools", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("detects BOM encodings and persists a manual GBK selection", async () => {
    const gbk = await importFixture("gbk.txt");
    const initial = await invoke<TxtEncodingInfo>("get_txt_encoding", {
      request: { bookId: gbk.book.id },
    });
    expect(initial.canChange).toBe(true);
    const decoded = await decodeTxt(gbk.book.id, "gbk");
    expect(decoded.phase).toBe("completed");
    expect(decoded.result?.selected).toBe("gbk");
    const window = await invoke<ContentWindow>("read_content_window", {
      request: {
        bookId: gbk.book.id,
        locator: null,
        maxUnits: 128,
        direction: "forward",
      },
    });
    expect(window.text).toContain("中文");

    const utf16 = await importFixture("utf16le.txt");
    const utf16Info = await invoke<TxtEncodingInfo>("get_txt_encoding", {
      request: { bookId: utf16.book.id },
    });
    expect(utf16Info.detected).toBe("utf16_le");
    const utf16Window = await invoke<ContentWindow>("read_content_window", {
      request: {
        bookId: utf16.book.id,
        locator: null,
        maxUnits: 128,
        direction: "forward",
      },
    });
    expect(utf16Window.text).toBe("1一\n");
  });

  it("persists TOC and de-duplicates bookmarks at one locator", async () => {
    const source = await importFixture("chapters.txt");
    const toc = await invoke<TocEntry[]>("list_toc", { request: { bookId: source.book.id } });
    expect(toc.length).toBeGreaterThan(0);
    const window = await invoke<ContentWindow>("read_content_window", {
      request: {
        bookId: source.book.id,
        locator: null,
        maxUnits: 256,
        direction: "forward",
      },
    });
    const request = {
      bookId: source.book.id,
      locator: window.locator,
      excerpt: window.text.slice(0, 24),
    };
    const first = await invoke<Bookmark>("add_bookmark", { request });
    const second = await invoke<Bookmark>("add_bookmark", { request });
    expect(second.id).toBe(first.id);
  });

  it("searches across a 64 KiB block boundary with UTF-16 locators", async () => {
    const source: ImportResult = await importFixture("cross-block.txt");
    const response = await invoke<SearchResponse>("search_book", {
      request: {
        bookId: source.book.id,
        query: "needle",
        caseSensitive: true,
        cursor: null,
        limit: 10,
        operationId: null,
      },
    });
    expect(response.matches).toHaveLength(1);
    expect(response.matches[0]?.excerpt).toContain("needle");
    expect(response.matches[0]?.locator.offset).toBe(65_535);
  });
  it("connects the preserved reader controls to TOC, bookmarks and highlighted search", async () => {
    const source = await importFixture("chapters.txt");
    await refreshLibraryInUi(source.book.id);
    await openBook(source.book.id);
    await browser.$('button[aria-label="目录"]').click();
    await browser.$('[role="dialog"]').waitForDisplayed();
    const chapter = await (await browser.$('[role="dialog"]')).$("button*=第一章");
    await chapter.waitForDisplayed();
    await chapter.click();
    await browser.waitUntil(async () => (await readPage()).start > 0);
    await browser.$('button[aria-label="添加书签"]').click();
    await browser.$('button[aria-label="书签"]').click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelectorAll('[role="dialog"] button[aria-label="删除书签"]').length,
        )) === 2,
    );
    await browser.keys("Escape");
    await browser.$('button[aria-label="搜索正文"]').click();
    const input = await browser.$('input[aria-label="搜索关键词"]');
    await input.setValue("结尾");
    await browser.keys("Enter");
    const result = await (await browser.$('[role="dialog"]')).$("button*=结尾");
    await result.waitForDisplayed();
    await result.click();
    await browser.$('[data-testid="reader-highlight"]').waitForDisplayed();
    expect(await browser.$('[data-testid="reader-highlight"]').getText()).toBe("结尾");
    await clickReaderControl("reader-close");
    await waitForReaderClosed();
  });
});

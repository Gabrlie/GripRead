import { browser, expect } from "@wdio/globals";
import { access, readFile, rename, unlink } from "node:fs/promises";

import {
  decodeTxt,
  dataPath,
  expectInvokeError,
  fixturePath,
  importFixture,
  invoke,
  managedAssetPath,
  waitForAppReady,
  refreshLibraryInUi,
  openBook,
  clickReaderControl,
  waitForReaderClosed,
  readPage,
  showReaderControls,
} from "./support";
import type {
  Bookmark,
  ContentWindow,
  ImportResult,
  SearchResponse,
  TocEntry,
  LibraryBook,
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
  it("accepts only a matching retained source during reassociation", async () => {
    const imported = await importFixture("mixed.txt");
    const retained = dataPath(`sources/${imported.asset.id}.txt`);
    await unlink(retained);

    const wrong = await expectInvokeError("reassociate_txt_source", {
      request: { bookId: imported.book.id, path: fixturePath("replacement.txt") },
    });
    expect(wrong.message).toContain("does not reproduce");
    await expect(access(retained)).rejects.toThrow();

    const info = await invoke<TxtEncodingInfo>("reassociate_txt_source", {
      request: { bookId: imported.book.id, path: fixturePath("mixed-duplicate.txt") },
    });
    expect(info.canChange).toBe(true);
    expect(await readFile(retained)).toEqual(await readFile(fixturePath("mixed-duplicate.txt")));
  });
  it("keeps metadata, preferences, records, and identity through archive and reimport", async () => {
    const imported = await importFixture("chapters.txt");
    const edited = await invoke<{ id: string; title: string; author: string | null }>(
      "update_book",
      { request: { bookId: imported.book.id, title: "  已编辑书名  ", author: " 作者 " } },
    );
    expect(edited).toMatchObject({
      id: imported.book.id,
      title: "已编辑书名",
      author: "作者",
    });
    const preferences = await invoke<{ layout: string; sort: string; groupId: string }>(
      "save_shelf_preferences",
      { request: { preferences: { layout: "grid", sort: "title", groupId: "all" } } },
    );
    expect(preferences).toEqual({ layout: "grid", sort: "title", groupId: "all" });

    await invoke("remove_book", { request: { bookId: imported.book.id } });
    expect(
      (await invoke<LibraryBook[]>("list_books")).some(
        (entry) => entry.book.id === imported.book.id,
      ),
    ).toBe(false);
    const removed = await invoke<LibraryBook[]>("list_removed_books");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.asset.id).toBe(imported.asset.id);
    expect(await invoke("get_shelf_preferences")).toEqual(preferences);

    await invoke("restore_book", { request: { bookId: imported.book.id } });
    expect(
      (await invoke<LibraryBook[]>("list_books")).some(
        (entry) => entry.book.id === imported.book.id,
      ),
    ).toBe(true);
    await invoke("remove_book", { request: { bookId: imported.book.id } });
    const repeated = await importFixture("chapters.txt");
    expect(repeated.duplicate).toBe(true);
    expect(repeated.book.id).toBe(imported.book.id);
    expect(repeated.asset.id).toBe(imported.asset.id);
    expect(
      (await invoke<LibraryBook[]>("list_removed_books")).some(
        (entry) => entry.book.id === imported.book.id,
      ),
    ).toBe(false);
  });
  it("connects the reader controls to TOC, bookmarks and highlighted search", async () => {
    const source = await importFixture("chapters.txt");
    await refreshLibraryInUi(source.book.id);
    await openBook(source.book.id);
    await showReaderControls();
    await browser.$('button[aria-label="目录"]').click();
    await browser.$('[role="dialog"]').waitForDisplayed();
    const chapter = await (await browser.$('[role="dialog"]')).$("button*=第一章");
    await chapter.waitForDisplayed();
    await chapter.click();
    await browser.waitUntil(async () => (await readPage()).start > 0);
    await browser.$('button[aria-label="更多"]').click();
    await browser.$("button*=添加当前位置书签").click();
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
    // Re-query on each poll: the page renderer replaces its paragraphs when
    // the seek replaces the page, so an element handle found earlier can go stale.
    await browser.waitUntil(async () =>
      browser.execute(() => {
        const mark = document.querySelector<HTMLElement>('[data-testid="reader-highlight"]');
        return Boolean(mark && mark.getClientRects().length > 0 && mark.textContent === "结尾");
      }),
    );
    expect(await browser.$('[data-testid="reader-highlight"]').getText()).toBe("结尾");

    await browser.$('button[aria-label="搜索正文"]').click();
    const searchInput = await browser.$('input[aria-label="搜索关键词"]');
    await searchInput.setValue("明确不存在的关键词");
    await browser.keys("Enter");
    await browser.$("p*=没有找到匹配内容").waitForDisplayed();

    const managedPath = await managedAssetPath(source.book.id);
    const missingPath = `${managedPath}.native-search-missing`;
    await rename(managedPath, missingPath);
    try {
      await searchInput.setValue("结尾");
      await browser.keys("Enter");
      await browser.$('[role="alert"]*=managed content file is missing').waitForDisplayed();
    } finally {
      await rename(missingPath, managedPath);
    }
    await clickReaderControl("reader-close");
    await waitForReaderClosed();
  });
});

import { browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import type {
  ContentWindow,
  ImportTask,
  ReaderLocator,
  TocEntry,
  TxtEncodingInfo,
  TxtTocRule,
} from "../../src/types/generated";
import {
  clickReaderControl,
  importFixture,
  invoke,
  openBook,
  readPage,
  refreshLibraryInUi,
  showReaderControls,
  useInstantPageTurns,
  waitForAppReady,
  waitForReaderClosed,
  waitForImport,
  fixturePath,
} from "./support";

async function closePanel() {
  await browser.keys("Escape");
  await browser.waitUntil(async () => !(await browser.$('[role="dialog"]').isExisting()));
}

async function selectRule(mode: TxtTocRule["mode"]) {
  await browser.waitUntil(async () => (await browser.$('[role="dialog"] select')).isEnabled());
  // Embedded WebDriver clicks <option> without changing its parent select.
  // Dispatch the native change event through the rendered control instead.
  await browser.execute((value) => {
    const select = document.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, mode);
}

describe("immersive reader tools", () => {
  before(async () => {
    await waitForAppReady();
    await useInstantPageTurns();
  });
  afterEach(async () => {
    if (await browser.$('[data-testid="reader-page"]').isExisting()) {
      await clickReaderControl("reader-close");
      await waitForReaderClosed();
    }
  });

  it("retries failed automatic detection with the explicit import encoding over IPC", async () => {
    const path = fixturePath("manual-encoding.txt");
    await writeFile(path, Buffer.from([0xf0, 0x28, 0x8c, 0x28]));
    const automatic = await invoke<ImportTask>("start_import", { request: { path } });
    const failed = await waitForImport(automatic.operationId);
    expect(failed.phase).toBe("failed");
    expect(failed.error?.code).toBe("unsupported_encoding");
    const explicit = await invoke<ImportTask>("start_import", {
      request: { path, encoding: "utf16_le" },
    });
    const completed = await waitForImport(explicit.operationId);
    expect(completed.phase).toBe("completed");
    const bookId = completed.result!.book.id;
    expect(
      (await invoke<TxtEncodingInfo>("get_txt_encoding", { request: { bookId } })).selected,
    ).toBe("utf16_le");
    const window = await invoke<ContentWindow>("read_content_window", {
      request: { bookId, locator: null, direction: "forward", maxUnits: 128 },
    });
    expect(window.text).toBe("\u28f0\u288c");
  });

  it("previews and persists per-book rules without changing the current passage", async () => {
    const book = await importFixture("chapters.txt");
    await refreshLibraryInUi(book.book.id);
    const initial = await openBook(book.book.id);
    await showReaderControls();
    await browser.$('button[aria-label="目录规则"]').click();
    const dialog = await browser.$('[role="dialog"]');
    await dialog.waitForDisplayed();
    await selectRule("english");
    await dialog.$("button=预览").click();
    await browser.$("p*=预览到 1 个章节").waitForDisplayed();
    expect(
      (await invoke<TxtTocRule>("get_toc_rule", { request: { bookId: book.book.id } })).mode,
    ).toBe("automatic");
    await dialog.$("button=应用本书").click();
    await browser.waitUntil(
      async () =>
        (await invoke<TxtTocRule>("get_toc_rule", { request: { bookId: book.book.id } })).mode ===
        "english",
    );
    await browser.waitUntil(async () => (await dialog.$("select")).isEnabled());
    const entries = await invoke<TocEntry[]>("list_toc", { request: { bookId: book.book.id } });
    expect(entries.map((entry) => entry.title)).toEqual(["Chapter 2"]);
    expect(entries[0]?.locator.contentVersion).toBe(book.book.contentVersion);
    expect((await readPage()).start).toBe(initial.start);

    await selectRule("custom");
    const expression = await dialog.$("input");
    await expression.setValue("(");
    await dialog.$("button=预览").click();
    await dialog.$('[role="alert"]').waitForDisplayed();
    expect(await dialog.$('[role="alert"]').getText()).toContain("invalid");
    expect(
      (await invoke<TxtTocRule>("get_toc_rule", { request: { bookId: book.book.id } })).mode,
    ).toBe("english");
    await closePanel();

    await browser.$('button[aria-label="编码格式"]').click();
    await browser.$("#reader-encoding").waitForDisplayed();
    expect(await browser.$("#reader-encoding").isEnabled()).toBe(true);
    await closePanel();
    await clickReaderControl("reader-close");
    await waitForReaderClosed();
    await browser.execute(() => location.reload());
    await waitForAppReady();
    expect(
      (await invoke<TxtTocRule>("get_toc_rule", { request: { bookId: book.book.id } })).mode,
    ).toBe("english");
    const saved = await invoke<ReaderLocator | null>("get_saved_reader_locator", {
      request: { bookId: book.book.id },
    });
    expect(saved?.offset ?? 0).toBe(initial.start);
  });

  it("turns automatically, pauses when controls open, and reopens paused", async () => {
    const book = await importFixture("mixed.txt");
    await refreshLibraryInUi(book.book.id);
    const first = await openBook(book.book.id);
    await showReaderControls();
    await browser.$('button[aria-label="自动翻页"]').click();
    await browser.$('input[aria-label="自动翻页间隔"]').waitForDisplayed();
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="自动翻页间隔"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await browser.$("output=2 秒").waitForDisplayed();
    await browser.$("button=开始自动翻页").click();
    await browser.waitUntil(async () => (await readPage()).start > first.start, { timeout: 8_000 });
    const next = await readPage();
    expect(next.start).toBe(first.end);
    await showReaderControls();
    const paused = await readPage();
    await browser.pause(2_300);
    expect((await readPage()).start).toBe(paused.start);
    await clickReaderControl("reader-close");
    await waitForReaderClosed();
    const reopened = await openBook(book.book.id);
    expect(reopened.start).toBe(paused.start);
    await browser.pause(2_300);
    expect((await readPage()).start).toBe(reopened.start);
    await clickReaderControl("reader-close");
    await waitForReaderClosed();
  });
});

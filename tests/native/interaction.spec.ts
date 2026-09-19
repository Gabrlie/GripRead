import { browser, expect } from "@wdio/globals";
import { unlink, writeFile } from "node:fs/promises";
import {
  clickReaderControl,
  clickSaveControl,
  dataPath,
  fixturePath,
  importFixture,
  openBook,
  readPage,
  refreshLibraryInUi,
  seekReaderProgress,
  waitForAppReady,
  waitForNextPage,
  waitForPageFit,
  waitForReaderClosed,
  useAnimatedPageTurns,
  useInstantPageTurns,
  TEST_TIMEOUT,
} from "./support";

async function closeBook() {
  await clickReaderControl("reader-close");
  await waitForReaderClosed();
}
async function ensureSettled() {
  await browser.pause(250);
}

describe("native typography and reader interaction", () => {
  before(async () => {
    await waitForAppReady();
    await useInstantPageTurns();
    await useAnimatedPageTurns();
  });

  it("renders every long-paragraph and newline-only page contiguously", async () => {
    for (const [name, text] of [
      ["long-paragraph.txt", "长段落😀ABC".repeat(2400)],
      ["blank-lines.txt", "\n".repeat(160)],
    ]) {
      await writeFile(fixturePath(name), text, "utf8");
      const imported = await importFixture(name);
      await refreshLibraryInUi(imported.book.id);
      let page = await openBook(imported.book.id);
      if (page.start !== 0) page = await seekReaderProgress(0);
      const pieces: string[] = [];
      for (let count = 0; ; count++) {
        const expected = text.slice(page.start, page.end);
        if (page.text !== expected) {
          throw new Error(
            `reader text mismatch for ${name} at page ${count}: start=${page.start} end=${page.end} ` +
              `expectedPrefix=${JSON.stringify(expected.slice(0, 16))} actualPrefix=${JSON.stringify(page.text.slice(0, 16))}`,
          );
        }
        expect(page.overflowHeight).toBeLessThanOrEqual(page.clientHeight + 1);
        pieces.push(page.text);
        if (page.end === text.length) break;
        if (count > 500) throw new Error("reader pagination made no bounded progress");
        await clickReaderControl("reader-next");
        const next = await waitForNextPage(page);
        expect(next.start).toBe(page.end);
        page = next;
      }
      expect(pieces.join("")).toBe(text);
      await closeBook();
    }
  });

  it("keeps selection, dialog keyboard input and typography changes scoped to their controls", async () => {
    const book = await importFixture("mixed.txt");
    await refreshLibraryInUi(book.book.id);
    let page = await openBook(book.book.id);
    await browser.execute(() => {
      const content = document.querySelector('[data-testid="reader-page"]')!;
      const range = document.createRange();
      range.selectNodeContents(content);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await browser.keys("ArrowRight");
    expect((await readPage()).start).toBe(page.start);
    await browser.execute(() => window.getSelection()?.removeAllRanges());
    const trigger = await browser.$('button[aria-label="排版设置"]');
    await trigger.click();
    const dialog = await browser.$('[role="dialog"]:not([hidden])');
    await dialog.waitForDisplayed();
    const larger = await dialog.$('button[aria-label="增大字号"]');
    await larger.waitForDisplayed();
    await larger.click();
    await browser.keys("Escape");
    await ensureSettled();
    await browser.waitUntil(async () =>
      browser.execute(() => !document.querySelector('[role="dialog"]:not([hidden])')),
    );
    expect(
      await browser.execute(() => !document.querySelector('[role="dialog"]:not([hidden])')),
    ).toBe(true);
    expect(await trigger.isFocused()).toBe(true);
    expect((await readPage()).start).toBe(page.start);
    await browser.setWindowSize(390, 700);
    await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) < 500);
    await ensureSettled();
    page = await waitForPageFit(page.start);
    expect(page.overflowHeight).toBeLessThanOrEqual(page.clientHeight + 1);
    const geometry = await browser.execute(() => {
      const track = document.querySelector(
        '[data-testid="reader-progress"] [data-slot="slider-track"]',
      )!;
      return {
        height: track.getBoundingClientRect().height,
        thumbs: document.querySelectorAll(
          '[data-testid="reader-progress"] [data-slot="slider-thumb"]',
        ).length,
      };
    });
    expect(geometry.height).toBeGreaterThan(0);
    expect(geometry.thumbs).toBe(1);
    await browser.setWindowSize(1100, 760);
    await ensureSettled();
    await waitForPageFit(page.start);
    await closeBook();
  });

  it("commits progress navigation and can move backward after seeking to the end", async () => {
    const book = await importFixture("mixed.txt");
    await refreshLibraryInUi(book.book.id);
    let start = await openBook(book.book.id);
    if (start.start !== 0) start = await seekReaderProgress(0);
    const slider = await browser.$('[data-testid="reader-progress"] input[type="range"]');
    await slider.waitForExist();
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="reader-progress"] input[type="range"]',
      );
      if (!input) throw new Error("progress slider input is missing");
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setValue) throw new Error("slider value setter is missing");
      setValue.call(input, "100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await browser.waitUntil(
      async () => !(await browser.$('[data-testid="reader-next"]').isEnabled()),
      { timeout: TEST_TIMEOUT, interval: 100 },
    );
    const end = await readPage();
    expect(end.end).toBe(end.total);
    expect(end.start).toBeGreaterThan(start.start);
    await clickReaderControl("reader-previous");
    await browser.waitUntil(async () => (await readPage()).start < end.start);
    const previous = await readPage();
    expect(previous.end).toBe(end.start);
    await closeBook();
  });

  it("keeps the reader open after a save failure and closes after retry", async () => {
    const book = await importFixture("mixed.txt");
    await refreshLibraryInUi(book.book.id);
    let first = await openBook(book.book.id);
    if (first.start !== 0) first = await seekReaderProgress(0);
    const fault = dataPath(".native-fault");
    await writeFile(fault, "save-position-error\n", "utf8");
    try {
      await clickReaderControl("reader-next");
      await waitForNextPage(first);
      await clickSaveControl();
      const saveError = await browser.$('[data-testid="reader-save-error"]');
      await saveError.waitForDisplayed();

      await clickReaderControl("reader-close");
      await browser.$('[data-testid="reader-page"]').waitForDisplayed();
      expect(await browser.$('[data-testid="reader-close"]').isEnabled()).toBe(true);

      await unlink(fault);
      const retry = await browser.$('[data-testid="reader-save-error"] button');
      await retry.click();
      await browser.waitUntil(
        async () => !(await browser.$('[data-testid="reader-save-error"]').isExisting()),
      );
      await closeBook();
    } finally {
      await unlink(fault).catch(() => undefined);
      if (await browser.$('[data-testid="reader-page"]').isExisting()) {
        await closeBook().catch(() => undefined);
      }
    }
  });
});

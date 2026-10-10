import { browser, expect } from "@wdio/globals";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  clickReaderControl,
  fixturePath,
  importFixture,
  openBook,
  readPage,
  refreshLibraryInUi,
  showReaderControls,
  waitForAppReady,
  waitForReaderClosed,
  useInstantPageTurns,
  ensureNativeVisible,
} from "./support";

async function mode(value: "单页" | "双页" | "滚动") {
  await showReaderControls();
  await browser.$('button[aria-label="设置"]').click();
  await browser.$(`button=${value}`).click();
  await browser.keys("Escape");
  const expected = { 单页: "single", 双页: "double", 滚动: "scroll" }[value];
  await browser.waitUntil(async () =>
    browser.execute(
      (next) =>
        document.querySelector("[data-reader-mode]")?.getAttribute("data-reader-mode") === next,
      expected,
    ),
  );
}

async function chapterEnd() {
  await showReaderControls();
  await browser.execute(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="reader-progress"] input',
    )!;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
  });
  await browser.waitUntil(async () =>
    browser.execute(
      () =>
        document.querySelector<HTMLInputElement>('[data-testid="reader-progress"] input')?.value ===
        "100",
    ),
  );
}

async function viewport() {
  await ensureNativeVisible();
  return browser.execute(() => {
    const root = document.querySelector<HTMLElement>("[data-reader-mode]")!;
    const scroll = document.querySelector<HTMLElement>('[data-testid="reader-scroll"]');
    const text = document.querySelector<HTMLElement>('[data-testid="reader-scroll-text"]');
    return {
      mode: root.dataset.readerMode,
      anchor: Number(root.dataset.readerPosition),
      chapter: Number(root.dataset.chapterStart),
      start: Number(text?.dataset.start),
      end: Number(text?.dataset.end),
      text: text?.textContent ?? "",
      top: scroll?.scrollTop ?? 0,
      automatic: root.dataset.readerAutomatic,
      loading: root.dataset.readerLoading,
      visible: document.visibilityState,
      focused: document.hasFocus(),
      selection: window.getSelection()?.toString(),
      errors: Array.from(document.querySelectorAll('[role="alert"]')).map(
        (node) => node.textContent,
      ),
      pages: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="reader-page"]')).map(
        (page) => ({
          start: Number(page.dataset.start),
          end: Number(page.dataset.end),
          text: page.textContent,
          overflow: page.scrollHeight - page.clientHeight,
        }),
      ),
    };
  });
}

describe("native reading modes", () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      const state = await viewport().catch(() => null);
      console.log(
        "Reader mode failure",
        state
          ? {
              ...state,
              text: state.text.slice(0, 80),
              pages: state.pages.map(({ start, end, overflow }) => ({ start, end, overflow })),
            }
          : "no reader",
      );
      if (await browser.$('[data-testid="reader-close"]').isExisting()) {
        await clickReaderControl("reader-close");
        await waitForReaderClosed();
      }
    }
  });
  before(async () => {
    await mkdir(resolve(".native-artifacts/reader-modes"), { recursive: true });
    await waitForAppReady();
    await useInstantPageTurns();
    await browser.setWindowSize(1100, 760);
  });

  it("keeps chapter endings within the spread and preserves the passage at the responsive breakpoint", async () => {
    const first = "第一章 开始\n" + "中文 English 😀 阅读。".repeat(850) + "\n";
    const text = first + "第二章 结尾\n短末章😀\n";
    await writeFile(fixturePath("modes.txt"), text);
    const imported = await importFixture("modes.txt");
    await refreshLibraryInUi(imported.book.id);
    await openBook(imported.book.id);
    await mode("双页");
    await browser.waitUntil(async () => (await viewport()).pages.length === 2);
    let current = await viewport();
    expect(current.pages[0].end).toBe(current.pages[1].start);
    expect(current.pages.every((page) => page.overflow <= 1)).toBe(true);
    await browser.saveScreenshot(resolve(".native-artifacts/reader-modes/double-desktop.png"));
    await chapterEnd();
    await browser.waitUntil(async () => (await viewport()).pages.at(-1)?.end === first.length);
    current = await viewport();
    expect(current.chapter).toBe(0);
    expect(current.pages.every((page) => page.end <= first.length)).toBe(true);
    const anchor = current.anchor;
    for (const width of [899, 900, 901]) {
      await browser.setWindowSize(width, 760);
      await browser.waitUntil(
        async () => (await viewport()).mode === (width < 900 ? "single" : "double"),
      );
      expect((await viewport()).anchor).toBe(anchor);
      if (width === 899)
        await browser.saveScreenshot(resolve(".native-artifacts/reader-modes/single-fallback.png"));
    }
    await showReaderControls();
    await browser.$('[data-testid="reader-next-chapter"]').click();
    await browser.waitUntil(async () => (await viewport()).chapter === first.length);
    await mode("滚动");
    await chapterEnd();
    await browser.waitUntil(async () => (await viewport()).chapter === first.length);
    const terminal = await viewport();
    await clickReaderControl("reader-close");
    await waitForReaderClosed();
    // A document reload forces the persisted position rather than the in-memory cache.
    await browser.refresh();
    await waitForAppReady();
    await browser.$(`[data-testid="library-book-${imported.book.id}"]`).click();
    await browser.$('[data-testid="reader-scroll"]').waitForExist();
    await browser.waitUntil(async () => (await viewport()).chapter === first.length);
    expect((await viewport()).anchor).toBe(terminal.anchor);
    await mode("单页");
    await clickReaderControl("reader-close");
    await waitForReaderClosed();
  });

  it("recycles long paragraphs in both directions without mounting the whole book", async () => {
    const text = "长段落😀ABC ".repeat(8000) + "\n\n结尾";
    await writeFile(fixturePath("scroll.txt"), text);
    const imported = await importFixture("scroll.txt");
    await refreshLibraryInUi(imported.book.id);
    await openBook(imported.book.id);
    await mode("滚动");
    for (let turn = 0; turn < 5; turn++) {
      const before = await viewport();
      await browser.execute(() => {
        const box = document.querySelector<HTMLElement>('[data-testid="reader-scroll"]')!;
        const body = document.querySelector<HTMLElement>('[data-testid="reader-scroll-text"]')!;
        box.scrollTop = body.scrollHeight - box.clientHeight * 1.5;
      });
      await browser.waitUntil(async () => (await viewport()).end > before.end);
      const after = await viewport();
      expect(after.text).toBe(text.slice(after.start, after.end));
      expect(after.text.length).toBeLessThanOrEqual(3 * 8193);
      expect(after.top).toBeGreaterThan(0);
    }
    const before = await viewport();
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-testid="reader-scroll"]')!.scrollTop = 10;
    });
    await browser.waitUntil(async () => (await viewport()).start < before.start);
    const after = await viewport();
    expect(after.text).toBe(text.slice(after.start, after.end));
    expect(after.text.length).toBeLessThanOrEqual(3 * 8193);
    await browser.saveScreenshot(resolve(".native-artifacts/reader-modes/scroll-desktop.png"));
    await mode("单页");
    const page = await readPage();
    expect(page.text).toBe(text.slice(page.start, page.end));
    await clickReaderControl("reader-close");
    await waitForReaderClosed();
  });

  it("keeps first render and mode switching bounded for 1, 10 and 50 MiB TXT", async () => {
    for (const size of [1, 10, 50]) {
      const name = `modes-${size}mb.txt`;
      await writeFile(fixturePath(name), "A".repeat(size * 1024 * 1024));
      const imported = await importFixture(name);
      await refreshLibraryInUi(imported.book.id);
      const started = Date.now();
      await openBook(imported.book.id);
      await mode("滚动");
      const current = await viewport();
      expect(current.text.length).toBeLessThanOrEqual(3 * 8193);
      console.log(
        `Reader ${size} MiB: first page + scroll ${Date.now() - started} ms; mounted ${current.text.length} UTF-16 units`,
      );
      await mode("单页");
      await clickReaderControl("reader-close");
      await waitForReaderClosed();
    }
  });

  it("settles every spread effect and pauses automatic scroll on manual interaction", async () => {
    await browser.setWindowSize(1100, 760);
    const imported = await importFixture("mixed.txt");
    await refreshLibraryInUi(imported.book.id);
    await openBook(imported.book.id);
    await mode("双页");
    for (const effect of ["仿真", "滑动", "淡入", "无"]) {
      await showReaderControls();
      await browser.$('button[aria-label="设置"]').click();
      await browser.$(`button=${effect}`).click();
      await browser.keys("Escape");
      const before = await viewport();
      await clickReaderControl("reader-next");
      await browser.waitUntil(async () => (await viewport()).anchor === before.pages.at(-1)?.end);
      await browser.waitUntil(async () =>
        browser.execute(
          () =>
            (
              document.querySelector('[data-testid="reader-animation"]')
                ?.firstElementChild as HTMLElement
            )?.style.visibility === "hidden",
        ),
      );
      await clickReaderControl("reader-previous");
      await browser.waitUntil(async () => (await viewport()).anchor === before.anchor);
    }
    await mode("滚动");
    await showReaderControls();
    await browser.$('button[aria-label="自动翻页"]').click();
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          document.fonts.status === "loaded" &&
          document.querySelector('[data-reader-loading="false"]') !== null,
      ),
    );
    const startAutomatic = await browser.$("button=开始自动滚动");
    await startAutomatic.waitForEnabled();
    await startAutomatic.click();
    const before = await viewport();
    await browser.waitUntil(async () => (await viewport()).anchor > before.anchor);
    await browser.execute(() =>
      document
        .querySelector('[data-testid="reader-scroll"]')!
        .dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 })),
    );
    const paused = await viewport();
    await browser.pause(250);
    expect((await viewport()).top).toBe(paused.top);
    await browser.setWindowSize(390, 700);
    await browser.waitUntil(async () => browser.execute(() => innerWidth === 390));
    await browser.saveScreenshot(resolve(".native-artifacts/reader-modes/scroll-narrow.png"));
    await mode("单页");
    await clickReaderControl("reader-close");
    await waitForReaderClosed();
  });
});

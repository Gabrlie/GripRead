import { browser, expect } from "@wdio/globals";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  clickReaderControl,
  importFixture,
  openBook,
  refreshLibraryInUi,
  waitForAppReady,
  waitForReaderClosed,
  useInstantPageTurns,
  invoke,
  fixturePath,
  TEST_TIMEOUT,
  showReaderControls,
  readPage,
} from "./support";
import type { LibraryGroup, ReaderPreferences } from "../../src/types/generated";

const baseline = process.env.GRIPREAD_PRESENTATION_MODE === "baseline";
const output = resolve(".native-artifacts", baseline ? "restored-baseline" : "restored-verified");
async function navigate(index: number, title: string) {
  await browser.execute((number) => {
    const selector = innerWidth < 768 ? 'nav[aria-label="Mobile Navigation Dock"]' : "aside nav";
    const target = document.querySelector<HTMLButtonElement>(
      `${selector} button:nth-child(${number})`,
    );
    if (!target) throw new Error("navigation control is missing");
    target.click();
  }, index);
  await browser.waitUntil(async () =>
    browser.execute(
      (name) =>
        Array.from(document.querySelectorAll("h1")).some(
          (node) => node.textContent?.trim() === name,
        ),
      title,
    ),
  );
}
async function capture(name: string) {
  await browser.waitUntil(async () => browser.execute(() => document.fonts.status === "loaded"));
  const geometry = await browser.execute(() => {
    const selectors = [
      "header",
      ".glass-header",
      ".glass-sidebar",
      ".glass-dock",
      "main",
      '[aria-label="书架书籍列表"]',
      '[data-testid="reader-page"]',
    ];
    return {
      width: innerWidth,
      height: innerHeight,
      contentWidth: document.documentElement.scrollWidth,
      elements: Object.fromEntries(
        selectors.map((selector) => {
          const node = document.querySelector(selector);
          if (!node) return [selector, null];
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return [
            selector,
            {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              background: style.backgroundColor,
              blur: style.backdropFilter,
              font: style.fontFamily,
              fontSize: style.fontSize,
            },
          ];
        }),
      ),
    };
  });
  expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.width);
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(geometry, null, 2));
  await browser.saveScreenshot(resolve(output, `${name}.png`));
}

async function waitForGlassMaterial(headerAlpha: string, dockAlpha: string, name: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        ({ headerAlpha: expectedHeader, dockAlpha: expectedDock }) => {
          const header = getComputedStyle(document.querySelector(".glass-header")!).backgroundColor;
          const dock = getComputedStyle(document.querySelector(".glass-dock")!).backgroundColor;
          return header.includes(expectedHeader) && dock.includes(expectedDock);
        },
        { headerAlpha, dockAlpha },
      ),
    {
      timeout: TEST_TIMEOUT,
      interval: 100,
      timeoutMsg: `glass material did not settle for ${name}`,
    },
  );
}

describe("current page geometry and material", () => {
  before(async () => {
    await waitForAppReady();
    await useInstantPageTurns();
    await mkdir(output, { recursive: true });
  });
  it("renders desktop and phone pages through their existing controls", async () => {
    const book = await importFixture("mixed.txt");
    await refreshLibraryInUi(book.book.id);
    for (const [label, width, height] of [
      ["desktop", 1100, 820],
      ["phone", 390, 780],
    ] as const) {
      await browser.setWindowSize(width, height);
      await browser.waitUntil(async () => (await browser.execute(() => innerWidth)) === width);
      for (const [index, title, page] of [
        [1, "书架", "bookshelf"],
        [2, "发现", "discover"],
        [3, "订阅", "subscriptions"],
        [4, "设置", "settings"],
      ] as const) {
        await navigate(index, title);
        await capture(`${label}-${page}`);
      }
      await navigate(1, "书架");
      await openBook(book.book.id);
      await capture(`${label}-reader`);
      if (!baseline) {
        const before = await readPage();
        const hidden = await browser.execute(() => ({
          controlsHidden: Boolean(
            document.querySelector('[data-testid="reader-close"]')?.closest("[inert]"),
          ),
          top: document.querySelector('[data-testid="reader-page"]')!.getBoundingClientRect().top,
          bottom: document.querySelector('[data-testid="reader-page"]')!.getBoundingClientRect()
            .bottom,
          height: innerHeight,
        }));
        expect(hidden.controlsHidden).toBe(true);
        expect(hidden.top).toBeLessThanOrEqual(24);
        expect(hidden.bottom).toBeGreaterThanOrEqual(hidden.height - 24);
        await showReaderControls();
        await capture(`${label}-reader-controls`);
        const after = await readPage();
        expect(after.start).toBe(before.start);
        expect(after.end).toBe(before.end);
        const actions = await browser.execute(() => ({
          top: Array.from(document.querySelectorAll("header button[aria-label]")).map((node) =>
            node.getAttribute("aria-label"),
          ),
          bottom: Array.from(
            document.querySelector('button[aria-label="搜索"]')!.parentElement!.children,
          ).map((node) => node.getAttribute("aria-label")),
        }));
        expect(actions.top).toEqual(["返回书架", "目录规则", "编码格式", "更多"]);
        expect(actions.bottom).toEqual(["搜索正文", "自动翻页", "目录", "设置"]);
      }
      await clickReaderControl("reader-close");
      await waitForReaderClosed();
    }
    // Persist through real IPC and reload the application to inspect the dark variants.
    const settings = await invoke<ReaderPreferences>("get_settings", {});
    await invoke("save_settings", { request: { settings: { ...settings, theme: "dark" } } });
    await browser.execute(() => location.reload());
    await waitForAppReady();
    await waitForGlassMaterial("0.58", "0.64", "dark");
    await capture("phone-bookshelf-dark");
    if (!baseline) {
      const material = await browser.execute(() => ({
        header: getComputedStyle(document.querySelector(".glass-header")!).backgroundColor,
        dock: getComputedStyle(document.querySelector(".glass-dock")!).backgroundColor,
      }));
      expect(material.header).toContain("0.58");
      expect(material.dock).toContain("0.64");
      await navigate(2, "发现");
      const discovery = await browser.execute(() => ({
        externalImages: Array.from(document.images).filter((image) => /^https?:/.test(image.src))
          .length,
        enabled: Array.from(document.querySelectorAll("main button, main input")).filter(
          (node) =>
            !(node as HTMLButtonElement).disabled && node.getAttribute("aria-disabled") !== "true",
        ).length,
      }));
      expect(discovery.externalImages).toBe(0);
      expect(discovery.enabled).toBe(0);
      await navigate(3, "订阅");
      expect(
        await browser.execute(() => document.querySelectorAll('a[href^="https:"]').length),
      ).toBe(0);
    }
  });
  it("persists group edits and reveals scrolling book content through glass", async () => {
    if (baseline) return;
    await navigate(1, "书架");
    const book = await importFixture("mixed.txt");
    await refreshLibraryInUi(book.book.id);
    await browser.$('button[aria-label="更多选项"]').click();
    await browser.$('[role="menuitem"]*=分组管理').click();
    const dialog = await browser.$('[role="dialog"]');
    await dialog.waitForDisplayed();
    const input = await dialog.$('input[aria-label="新分组名称"]');
    await input.setValue("验收分组");
    await dialog.$('button[type="submit"]').click();
    const groupButton = await dialog.$("button*=验收分组");
    await groupButton.waitForDisplayed();
    await groupButton.click();
    const member = await dialog.$('input[type="checkbox"]');
    await member.click();
    await browser.waitUntil(async () =>
      (await invoke<LibraryGroup[]>("list_groups")).some(
        (group) => group.name === "验收分组" && group.bookIds.includes(book.book.id),
      ),
    );
    await browser.keys("Escape");
    await browser.waitUntil(async () =>
      browser.execute(() => !document.querySelector('[role="dialog"]')),
    );
    await browser.execute(() => location.reload());
    await waitForAppReady();
    const stored = (await invoke<LibraryGroup[]>("list_groups")).find(
      (group) => group.name === "验收分组",
    );
    expect(stored?.bookIds).toContain(book.book.id);
    // Exercise authoritative empty snapshots, preserving all imported books.
    for (const group of await invoke<LibraryGroup[]>("list_groups"))
      await invoke("delete_group", { request: { id: group.id } });
    await refreshLibraryInUi(book.book.id);
    await browser.waitUntil(async () =>
      browser.execute(
        () => document.querySelectorAll('[data-testid="shelf-groups"] [role="tab"]').length === 1,
      ),
    );
    expect(await browser.$(`[data-testid="library-book-${book.book.id}"]`).isExisting()).toBe(true);
    for (let i = 0; i < 7; i++) {
      const name = `glass-${i}.txt`;
      await writeFile(fixturePath(name), `书架材质检查 ${i}\n正文用于本地测试。`, "utf8");
      await importFixture(name);
    }
    await refreshLibraryInUi(book.book.id);
    for (const [name, theme, oledBlack, headerAlpha, dockAlpha] of [
      ["light", "light", false, "0.45", "0.52"],
      ["dark", "dark", false, "0.58", "0.64"],
      ["oled", "dark", true, "0.65", "0.7"],
    ] as const) {
      const current = await invoke<ReaderPreferences>("get_settings");
      await invoke("save_settings", { request: { settings: { ...current, theme, oledBlack } } });
      await browser.execute(() => location.reload());
      await waitForAppReady();
      await browser.execute(() => window.scrollTo(0, 180));
      await browser.waitUntil(async () => (await browser.execute(() => scrollY)) > 100);
      await waitForGlassMaterial(headerAlpha, dockAlpha, name);
      await capture(`phone-glass-scroll-${name}`);
      const material = await browser.execute(() => ({
        header: getComputedStyle(document.querySelector(".glass-header")!).backgroundColor,
        dock: getComputedStyle(document.querySelector(".glass-dock")!).backgroundColor,
        blur: getComputedStyle(document.querySelector(".glass-header")!).backdropFilter,
        opacity: getComputedStyle(document.querySelector(".glass-header")!).opacity,
      }));
      expect(material.header).toContain(headerAlpha);
      expect(material.dock).toContain(dockAlpha);
      expect(material.blur).toContain("20px");
      expect(material.opacity).toBe("1");
    }
  });
});

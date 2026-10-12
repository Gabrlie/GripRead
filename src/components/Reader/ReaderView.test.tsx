// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "./ReaderView";
import { paginateText } from "../../reader/pagination";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type {
  ContentWindow,
  ReadContentRequest,
  LibraryBook,
  ReaderLocator,
  SearchResponse,
  TocEntry,
  BookTocSettings,
  TxtTocRule,
} from "../../types/generated";
import { ruleServiceMocks, tocEntry, tocListing, fontServiceMocks } from "../../test/toc";
import { DEFAULT_READING_STYLE } from "../../types/generated";
import { syncServiceMocks, unconfiguredWebDav } from "../../test/sync";
import { sourceServiceMocks } from "../../test/sources";

const navigation = vi.hoisted(() => ({
  activeBook: null as LibraryBook | null,
  closeReader: vi.fn(),
  takeReaderPage: vi.fn((): "contents" | null => null),
  reducedMotion: false,
}));
vi.mock("../../context/AppContext", () => ({ useApp: () => navigation }));
vi.mock("motion/react", () => ({ useReducedMotion: () => navigation.reducedMotion }));
vi.mock("../../reader", async () => {
  const reader = await vi.importActual<typeof import("../../reader")>("../../reader");
  return {
    ...reader,
    DomReaderMeasurer: class {
      measure(window: ContentWindow) {
        return reader.paginateText(window.text, window.startOffset, 60);
      }
      setHeadings() {}
      dispose() {}
    },
    PageTurnAdapter: class {
      followsDrag = false;
      setHeadings() {}
      aim() {}
      beginDrag() {}
      updateDrag() {}
      endDrag() {}
      clearDrag() {}
      takeCancelled() {
        return false;
      }
      skipNextAnimation() {}
      setEffect() {}
      setPages() {}
      present() {}
      resize() {}
      destroy() {}
    },
  };
});

const text = "Chapter 1\nRead a page. ".repeat(20);
const locator = (offset = 0): ReaderLocator => ({
  bookId: "reader-book",
  contentVersion: "v1",
  resourceId: "full-text",
  offset,
  contextBefore: "",
  contextAfter: "",
});
const chapter = (title: string, offset = 0): TocEntry => tocEntry(0, title, locator(offset));
const RULES: TxtTocRule[] = [
  {
    id: "chinese",
    name: "中文章节",
    pattern: "^第.+章.*$",
    example: "第一章 开始",
    serial: 0,
    enabled: true,
    builtin: true,
  },
  {
    id: "english",
    name: "英文章节",
    pattern: "^Chapter \\d+.*$",
    example: "Chapter 1",
    serial: 1,
    enabled: true,
    builtin: true,
  },
];
const entry: LibraryBook = {
  book: {
    id: "reader-book",
    title: "阅读测试",
    author: null,
    contentVersion: "v1",
    createdAt: 1,
    updatedAt: 1,
  },
  asset: {
    id: "asset",
    bookId: "reader-book",
    kind: "txt",
    sha256: "hash",
    byteLength: text.length,
    contentVersion: "v1",
    availability: "ready",
    createdAt: 1,
  },
  locator: null,
  totalLength: text.length,
  txtEncoding: null,
  lastReadAt: null,
  removedAt: null,
  shelfState: null,
  coverAssetId: null,
  useReplaceRules: true,
  inCloud: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function runtime() {
  return new AppRuntime({
    library: {
      listGroups: vi.fn(async () => []),
      createGroup: vi.fn(),
      renameGroup: vi.fn(),
      deleteGroup: vi.fn(),
      moveBook: vi.fn(async () => undefined),
      ensureTextTransforms: vi.fn(async () => null),
      setBookReplaceRules: vi.fn(async () => undefined),
      pickTxtFiles: vi.fn(async () => []),
      pickTxtFolder: vi.fn(async () => []),
      pickBookCover: vi.fn(async () => false),
      clearBookCover: vi.fn(async () => undefined),
      readAsset: vi.fn(async () => new ArrayBuffer(0)),
      addReadingTime: vi.fn(async () => undefined),
      readingStats: vi.fn(async () => ({ totalSeconds: 0, todaySeconds: 0, days: [], books: [] })),
      listRemovedBooks: vi.fn(async () => []),
      updateBook: vi.fn(),
      removeBook: vi.fn(),
      deleteBook: vi.fn(),
      restoreBook: vi.fn(),
      listBooks: vi.fn(async () => [entry]),
      pickAndImportTxt: vi.fn(async () => null),
      startImport: vi.fn(),
      cancelImport: vi.fn(),
      getImportStatus: vi.fn(),
      onImportProgress: vi.fn(async () => () => {}),
      startTxtDecode: vi.fn(),
      getTxtDecodeStatus: vi.fn(),
      cancelTxtDecode: vi.fn(async () => ({ requested: true })),
      onTxtDecodeProgress: vi.fn(async () => () => {}),
      getBookInfo: vi.fn(),
      getTxtEncoding: vi.fn(async () => ({
        detected: "utf8" as const,
        selected: "auto" as const,
        state: "clean" as const,
        canChange: true,
      })),
      pickAndReassociateTxt: vi.fn(async () => null),
      reassociateTxtSource: vi.fn(),
    },
    reader: {
      // Forward windows start at the requested position, like the Rust reader.
      readContentWindow: vi.fn(async (request: ReadContentRequest) => {
        const start =
          request.direction === "forward" && request.locator ? request.locator.offset : 0;
        return {
          ...locator(start),
          text: text.slice(start),
          startOffset: start,
          endOffset: text.length,
          totalLength: text.length,
          hasBefore: start > 0,
          hasAfter: false,
          locator: locator(start),
        };
      }),
      resolveLocator: vi.fn(async () => locator()),
      resolveOffset: vi.fn(async (request) => locator(request.offset)),
      saveReaderLocator: vi.fn(async (value) => value),
      getSavedReaderLocator: vi.fn(async () => null),
      listToc: vi.fn(async () => tocListing([chapter("初始章节")])),
      ...ruleServiceMocks(),
      listBookmarks: vi.fn(async () => []),
      addBookmark: vi.fn(),
      deleteBookmark: vi.fn(),
      updateBookmarkNote: vi.fn(async () => undefined),
      listReplaceRules: vi.fn(async () => []),
      saveReplaceRule: vi.fn(async (rule) => rule),
      deleteReplaceRules: vi.fn(async () => undefined),
      orderReplaceRules: vi.fn(async () => []),
      importReplaceRules: vi.fn(async () => []),
      exportReplaceRules: vi.fn(async () => "[]"),
      testReplaceRule: vi.fn(async (_rule, sample: string) => sample),
      search: vi.fn(),
      cancelSearch: vi.fn(async () => ({ requested: true })),
    },
    settings: {
      getSettings: vi.fn(async () => ({
        theme: "light" as const,
        paperTone: "bone-white" as const,
        oledBlack: false,
        fontSize: 18,
        lineHeight: 1.8,
        fontFamily: "sans" as const,
        pageTurnEffect: "instant" as const,
        autoPageSeconds: 8,
        readingMode: "single" as const,
        autoScrollSpeed: 40,
        style: DEFAULT_READING_STYLE,
      })),
      saveSettings: vi.fn(async (value) => value),
      getShelfPreferences: vi.fn(async () => ({
        layout: "list" as const,
        sort: "recent_read" as const,
        groupId: "all",
      })),
      saveShelfPreferences: vi.fn(async (value) => value),
      ...fontServiceMocks(),
    },
    sync: syncServiceMocks(),
    sources: sourceServiceMocks(),
  } satisfies AppServices);
}

beforeEach(() => {
  navigation.reducedMotion = false;
  navigation.activeBook = entry;
  navigation.closeReader.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 400,
    bottom: 800,
    width: 400,
    height: 800,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Taps the reading surface at a fraction of its size (jsdom has no layout). */
function tapSurface(fractionX = 0.5, fractionY = 0.5) {
  const surface = screen.getByTestId("reader-surface");
  surface.getBoundingClientRect = () => new DOMRect(0, 0, 400, 800);
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: 400 * fractionX,
      clientY: 800 * fractionY,
    });
    Object.defineProperty(event, "isPrimary", { value: true });
    fireEvent(surface, event);
  }
}

async function view(app: AppRuntime) {
  await app.settings.load();
  await app.library.refresh();
  render(
    <RuntimeContext.Provider value={app}>
      <ReaderView />
    </RuntimeContext.Provider>,
  );
  await screen.findByTestId("reader-page");
  await waitFor(() => expect(screen.queryByText("正在读取书籍信息…")).toBeNull());
  tapSurface();
}

describe("reader directory and search operation ownership", () => {
  it("selects a chapter rule for the book and refreshes the directory when the save completes", async () => {
    const app = runtime();
    const saving = deferred<BookTocSettings>();
    vi.mocked(app.services.reader.listTxtTocRules).mockResolvedValue(RULES);
    vi.mocked(app.services.reader.saveBookTocSettings).mockReturnValue(saving.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "TXT目录规则" }));
    await userEvent.click(screen.getByRole("radio", { name: /英文章节/ }));
    expect(app.services.reader.saveBookTocSettings).toHaveBeenCalledWith(entry.book.id, {
      ruleId: "english",
      splitLongChapters: false,
    });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    vi.mocked(app.services.reader.listToc).mockResolvedValue(
      tocListing([chapter("保存后章节")], "英文章节"),
    );
    await act(async () => saving.resolve({ ruleId: "english", splitLongChapters: false }));
    await userEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(await screen.findByRole("button", { name: /保存后章节/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /初始章节/ })).toBeNull();
    expect(screen.getByTestId("reader-page").getAttribute("data-start")).toBe("0");
  });

  it("shows volumes, the current chapter, and jumps from Contents", async () => {
    const app = runtime();
    const second = text.indexOf("Chapter", 40);
    vi.mocked(app.services.reader.listToc).mockResolvedValue(
      tocListing([
        { ...tocEntry(0, "第一卷 起", locator(0)), volume: true },
        tocEntry(1, "第一章 开端", locator(0)),
        tocEntry(2, "第二章 远行", locator(second)),
      ]),
    );
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录" }));
    const current = await screen.findByRole("button", { name: /第一章 开端/ });
    expect(current.getAttribute("aria-current")).toBe("location");
    await userEvent.click(screen.getByRole("button", { name: "收起 第一卷 起" }));
    expect(screen.queryByRole("button", { name: /第二章 远行/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "展开 第一卷 起" }));
    await userEvent.click(screen.getByRole("button", { name: /第二章 远行/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "目录" })).toBeNull());
    await waitFor(() =>
      expect(Number(screen.getByTestId("reader-page").getAttribute("data-end"))).toBeGreaterThan(
        second,
      ),
    );
  });

  it("returns to the detail page when contents it opened are left without a choice", async () => {
    const app = runtime();
    navigation.takeReaderPage.mockReturnValueOnce("contents");
    await view(app);
    expect(await screen.findByRole("dialog", { name: "目录" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(navigation.closeReader).toHaveBeenCalledWith(true));
  });

  it("stays in the reader after a place is chosen in contents the detail page opened", async () => {
    const app = runtime();
    vi.mocked(app.services.reader.listToc).mockResolvedValue(
      tocListing([tocEntry(0, "第一章 开端", locator(0))]),
    );
    navigation.takeReaderPage.mockReturnValueOnce("contents");
    await view(app);
    await userEvent.click(await screen.findByRole("button", { name: /第一章 开端/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "目录" })).toBeNull());
    expect(navigation.closeReader).not.toHaveBeenCalled();
  });

  it("lists bookmarks in Contents and opens them", async () => {
    const app = runtime();
    const at = text.indexOf("Read", 80);
    vi.mocked(app.services.reader.listBookmarks).mockResolvedValue([
      {
        id: "mark",
        bookId: entry.book.id,
        contentVersion: "v1",
        locator: locator(at),
        excerpt: "书签摘录",
        note: "",
        createdAt: 1,
      },
    ]);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录" }));
    await userEvent.click(screen.getByRole("tab", { name: /书签/ }));
    await userEvent.click(screen.getByRole("button", { name: /书签摘录/ }));
    await waitFor(() =>
      expect(Number(screen.getByTestId("reader-page").getAttribute("data-end"))).toBeGreaterThan(
        at,
      ),
    );
  });

  it("highlights an opened search match on the page", async () => {
    const app = runtime();
    const offset = text.indexOf("page", 10);
    vi.mocked(app.services.reader.search).mockResolvedValue({
      contentVersion: "v1",
      matches: [
        {
          ordinal: 0,
          locator: locator(offset),
          excerpt: "Read a page",
          matchStart: offset,
          matchEnd: offset + 4,
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索关键词" }), "page");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: /Read a page/ }));
    expect(screen.getByRole("button", { name: /第 1\/1 处/ })).toBeTruthy();
    expect((await screen.findByTestId("reader-highlight")).textContent).toBe("page");
  });

  it("shows each page's part of a match that crosses a page boundary", async () => {
    const app = runtime();
    const boundary = paginateText(text, 0, 60)[0].endOffset;
    const start = boundary - 3;
    // Page boundaries are those of the whole text measured from its start.
    vi.mocked(app.services.reader.readContentWindow).mockImplementation(async () => ({
      ...locator(),
      text,
      startOffset: 0,
      endOffset: text.length,
      totalLength: text.length,
      hasBefore: false,
      hasAfter: false,
      locator: locator(),
    }));
    vi.mocked(app.services.reader.search).mockResolvedValue({
      contentVersion: "v1",
      matches: [
        {
          ordinal: 0,
          locator: locator(start),
          excerpt: "跨页结果",
          matchStart: start,
          matchEnd: boundary + 3,
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索关键词" }), "page");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: /跨页结果/ }));
    await waitFor(() =>
      expect(screen.getByTestId("reader-highlight").textContent).toBe(text.slice(start, boundary)),
    );
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("reader-page").getAttribute("data-start")).toBe(String(boundary)),
    );
    expect(screen.getByTestId("reader-highlight").textContent).toBe(
      text.slice(boundary, boundary + 3),
    );
  });

  it("hides the overlay toolbars when the reader drags the scroll view", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // jsdom has no layout; scroll position tracking only needs empty rectangles.
    const rect = () => new DOMRect();
    Range.prototype.getBoundingClientRect = rect;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    const app = runtime();
    await app.settings.load();
    app.settings.set({ readingMode: "scroll" });
    await app.library.refresh();
    render(
      <RuntimeContext.Provider value={app}>
        <ReaderView />
      </RuntimeContext.Provider>,
    );
    await screen.findByTestId("reader-scroll");
    await waitFor(() => expect(screen.queryByText("正在读取书籍信息…")).toBeNull());
    // The scroll view remounts once the opened window is published.
    const scroll = screen.getByTestId("reader-scroll");
    const header = screen.getByTestId("reader-close").closest("header")!;
    tapSurface();
    await waitFor(() => expect(header.hasAttribute("inert")).toBe(false));
    fireEvent.touchMove(scroll);
    await waitFor(() => expect(header.hasAttribute("inert")).toBe(true));
    await app.settings.flush();
    vi.unstubAllGlobals();
  });

  it("turns with Legado's tap zones and closes the menu on the next tap", async () => {
    const app = runtime();
    await view(app);
    const header = screen.getByTestId("reader-close").closest("header")!;
    expect(header.hasAttribute("inert")).toBe(false);
    tapSurface(0.9, 0.5);
    await waitFor(() => expect(header.hasAttribute("inert")).toBe(true));
    expect(screen.getByTestId("reader-page").getAttribute("data-start")).toBe("0");
    tapSurface(0.9, 0.5);
    await waitFor(() =>
      expect(screen.getByTestId("reader-page").getAttribute("data-start")).not.toBe("0"),
    );
    tapSurface(0.5, 0.15);
    await waitFor(() =>
      expect(screen.getByTestId("reader-page").getAttribute("data-start")).toBe("0"),
    );
  });

  it("keeps automatic turning running while its panel is shown, hidden, or the page is turned", async () => {
    const app = runtime();
    await view(app);
    // The tool starts turning at once and shows its panel.
    await userEvent.click(screen.getByRole("button", { name: "自动翻页" }));
    const panel = await screen.findByRole("region", { name: "自动翻页" });
    expect(within(panel).getByRole("status").textContent).toContain("自动翻页中");
    // A tap on the centre hides the panel and another shows it again.
    tapSurface();
    await waitFor(() => expect(screen.queryByRole("region", { name: "自动翻页" })).toBeNull());
    tapSurface();
    const shown = await screen.findByRole("region", { name: "自动翻页" });
    expect(within(shown).getByRole("status").textContent).toContain("自动翻页中");
    // A manual turn restarts the countdown instead of pausing.
    tapSurface(0.9, 0.5);
    await waitFor(() =>
      expect(screen.getByTestId("reader-page").getAttribute("data-start")).not.toBe("0"),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "自动翻页" })).getByRole("status").textContent,
      ).toContain("自动翻页中"),
    );
    await userEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(
      within(screen.getByRole("region", { name: "自动翻页" })).getByRole("status").textContent,
    ).toContain("已暂停");
  });

  it("configures the bottom bar and 简繁 from the top bar's More menu", async () => {
    const app = runtime();
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "底部工具栏" }));
    const dialog = await screen.findByRole("dialog", { name: "底部工具栏" });
    await userEvent.click(within(dialog).getByRole("button", { name: "移除 界面" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "底部工具栏" })).toBeNull());
    expect(screen.queryByRole("button", { name: /^界面$/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /简繁转换/ }));
    await userEvent.click(await screen.findByRole("radio", { name: /简转繁/ }));
    await waitFor(() =>
      expect(app.settings.getSnapshot().value?.style.chineseConversion).toBe("to_traditional"),
    );
  });

  it("asks to jump to another device's progress and uploads its own on leaving", async () => {
    const app = runtime();
    const sync = app.services.sync;
    vi.mocked(sync.getWebDav).mockResolvedValue({
      ...unconfiguredWebDav(),
      username: "reader",
      configured: true,
      syncProgress: true,
    });
    const target = text.length - 30;
    vi.mocked(sync.fetchProgress).mockResolvedValue({
      deviceId: "other",
      deviceName: "书房平板",
      revision: 3,
      writtenAt: 1,
      chapterTitle: "Chapter 1",
      excerpt: "Read a page.",
      locator: locator(target),
    });
    await view(app);
    const dialog = await screen.findByRole("dialog", { name: "云端进度" });
    expect(within(dialog).getByText(/书房平板/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "跳转" }));
    await waitFor(() =>
      expect(Number(screen.getByTestId("reader-page").getAttribute("data-end"))).toBeGreaterThan(
        target,
      ),
    );
    expect(sync.acknowledgeProgress).toHaveBeenCalledWith("reader-book", "other", 3);
    await userEvent.click(screen.getByTestId("reader-close"));
    await waitFor(() =>
      expect(sync.uploadProgress).toHaveBeenCalledWith("reader-book", expect.any(String)),
    );
  });

  it("turns from a tap on the margin beside the text", async () => {
    const app = runtime();
    await view(app);
    tapSurface();
    // The far right edge is outside the centred text column on wide screens.
    tapSurface(0.99, 0.5);
    await waitFor(() =>
      expect(screen.getByTestId("reader-page").getAttribute("data-start")).not.toBe("0"),
    );
  });

  it("turns a page when a swipe starts on the text", async () => {
    const app = runtime();
    await view(app);
    tapSurface();
    const surface = screen.getByTestId("reader-surface");
    const text = screen.getByTestId("reader-page").querySelector("p")!;
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 400 });
      Object.defineProperty(event, "isPrimary", { value: true });
      fireEvent(type === "pointerdown" ? text : surface, event);
    };
    pointer("pointerdown", 300);
    pointer("pointermove", 260);
    pointer("pointermove", 120);
    pointer("pointerup", 100);
    await waitFor(() =>
      expect(screen.getByTestId("reader-page").getAttribute("data-start")).not.toBe("0"),
    );
  });

  it("returns to the shelf immediately while a position save is still pending", async () => {
    const app = runtime();
    const gate = deferred<ReaderLocator>();
    vi.mocked(app.services.reader.saveReaderLocator).mockReturnValueOnce(gate.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "返回书架" }));
    expect(navigation.closeReader).toHaveBeenCalledOnce();
    await act(async () => {
      gate.resolve(locator());
      await app.flush();
    });
  });

  it("uses instant presentation under reduced motion without replacing the selected effect", async () => {
    const app = runtime();
    await app.settings.load();
    app.settings.set({ pageTurnEffect: "curl" });
    navigation.reducedMotion = true;
    await view(app);
    expect(
      screen
        .getByTestId("reader-page")
        .closest("[data-reader-effect]")
        ?.getAttribute("data-reader-effect"),
    ).toBe("instant");
    expect(app.settings.getSnapshot().value?.pageTurnEffect).toBe("curl");
    navigation.reducedMotion = false;
    await act(async () => app.settings.set({ fontSize: 19 }));
    expect(
      screen
        .getByTestId("reader-page")
        .closest("[data-reader-effect]")
        ?.getAttribute("data-reader-effect"),
    ).toBe("curl");
    await app.settings.flush();
  });

  it("cancels a closed search and ignores its late results", async () => {
    const app = runtime();
    const searching = deferred<SearchResponse>();
    vi.mocked(app.services.reader.search).mockReturnValue(searching.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索关键词" }), "page");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "搜索" }));
    const request = vi.mocked(app.services.reader.search).mock.calls[0][0];
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(app.services.reader.cancelSearch).toHaveBeenCalledWith(request.operationId);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "搜索" })),
    );
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));
    await act(async () =>
      searching.resolve({
        contentVersion: "v1",
        matches: [
          { ordinal: 0, locator: locator(), excerpt: "过期搜索结果", matchStart: 0, matchEnd: 4 },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    );
    expect(screen.queryByText("过期搜索结果")).toBeNull();
    expect(screen.queryByText("正在搜索…")).toBeNull();
  });

  it("waits for the pending directory write when the native exit flush begins", async () => {
    const app = runtime();
    const saving = deferred<BookTocSettings>();
    vi.mocked(app.services.reader.listTxtTocRules).mockResolvedValue(RULES);
    vi.mocked(app.services.reader.saveBookTocSettings).mockReturnValue(saving.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "TXT目录规则" }));
    await userEvent.click(screen.getByRole("radio", { name: /英文章节/ }));
    let complete = false;
    const flush = app.readerFlush!().then(() => {
      complete = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(complete).toBe(false);
    await act(async () => {
      saving.resolve({ ruleId: "english", splitLongChapters: false });
      await flush;
    });
    expect(complete).toBe(true);
  });

  it("reports a failed rule selection after the dialog closes and offers a working retry", async () => {
    const app = runtime();
    const saving = deferred<BookTocSettings>();
    vi.mocked(app.services.reader.listTxtTocRules).mockResolvedValue(RULES);
    vi.mocked(app.services.reader.saveBookTocSettings).mockReturnValueOnce(saving.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "TXT目录规则" }));
    await userEvent.click(screen.getByRole("radio", { name: /英文章节/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => saving.reject(new Error("database unavailable")));
    expect((await screen.findByRole("alert")).textContent).toContain("目录设置保存失败");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(app.services.reader.saveBookTocSettings).toHaveBeenCalledTimes(2);
    expect(app.services.reader.saveBookTocSettings).toHaveBeenLastCalledWith(entry.book.id, {
      ruleId: "english",
      splitLongChapters: false,
    });
  });

  it("retains a failed in-flight rule selection so retrying native exit retries the write", async () => {
    const app = runtime();
    const saving = deferred<BookTocSettings>();
    vi.mocked(app.services.reader.listTxtTocRules).mockResolvedValue(RULES);
    vi.mocked(app.services.reader.saveBookTocSettings).mockReturnValueOnce(saving.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "TXT目录规则" }));
    await userEvent.click(screen.getByRole("radio", { name: /英文章节/ }));
    const firstFlush = app.readerFlush!().then(
      () => null,
      (error: unknown) => error,
    );
    await act(async () => {
      saving.reject(new Error("temporary write failure"));
      expect(await firstFlush).toEqual(new Error("temporary write failure"));
    });
    await act(async () => app.readerFlush!());
    expect(app.services.reader.saveBookTocSettings).toHaveBeenCalledTimes(2);
  });
});

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
  LibraryBook,
  ReaderLocator,
  SearchResponse,
  TocEntry,
  TxtTocRule,
  TxtTocRulePreview,
} from "../../types/generated";

const navigation = vi.hoisted(() => ({
  activeBook: null as LibraryBook | null,
  closeReader: vi.fn(),
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
      dispose() {}
    },
    StPageFlipAdapter: class {
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
const chapter = (title: string): TocEntry => ({ ordinal: 0, title, locator: locator() });
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
      setBookGroups: vi.fn(),
      listRemovedBooks: vi.fn(async () => []),
      updateBook: vi.fn(),
      removeBook: vi.fn(),
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
      readContentWindow: vi.fn(async () => ({
        ...locator(),
        text,
        startOffset: 0,
        endOffset: text.length,
        totalLength: text.length,
        hasBefore: false,
        hasAfter: false,
        locator: locator(),
      })),
      resolveLocator: vi.fn(async () => locator()),
      resolveOffset: vi.fn(async (request) => locator(request.offset)),
      saveReaderLocator: vi.fn(async (value) => value),
      getSavedReaderLocator: vi.fn(async () => null),
      listToc: vi.fn(async () => [chapter("初始章节")]),
      getTocRule: vi.fn(async () => ({ mode: "automatic" as const, pattern: "" })),
      previewTocRule: vi.fn(async () => ({ entries: [chapter("新目录章节")] })),
      saveTocRule: vi.fn(async (request) => request.rule),
      listBookmarks: vi.fn(async () => []),
      addBookmark: vi.fn(),
      deleteBookmark: vi.fn(),
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
      })),
      saveSettings: vi.fn(async (value) => value),
      getShelfPreferences: vi.fn(async () => ({
        layout: "list" as const,
        sort: "recent_read" as const,
        groupId: "all",
      })),
      saveShelfPreferences: vi.fn(async (value) => value),
    },
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

async function view(app: AppRuntime) {
  await app.settings.load();
  await app.library.refresh();
  render(
    <RuntimeContext.Provider value={app}>
      <ReaderView />
    </RuntimeContext.Provider>,
  );
  const page = await screen.findByTestId("reader-page");
  fireEvent(page, new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 200 }));
  fireEvent(page, new MouseEvent("pointerup", { bubbles: true, clientX: 200, clientY: 200 }));
  await waitFor(() => expect(screen.queryByText("正在读取书籍信息…")).toBeNull());
}

describe("reader directory and search operation ownership", () => {
  it("waits for the initial rule read before accepting a draft or preview", async () => {
    const app = runtime();
    const loading = deferred<TxtTocRule>();
    vi.mocked(app.services.reader.getTocRule).mockReturnValue(loading.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录规则" }));
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "预览" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(app.services.reader.previewTocRule).not.toHaveBeenCalled();
    await act(async () => loading.resolve({ mode: "english", pattern: "" }));
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("english");
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(false);
  });

  it("keeps a save owned after closing the panel and refreshes the directory when it completes", async () => {
    const app = runtime();
    const saving = deferred<TxtTocRule>();
    vi.mocked(app.services.reader.saveTocRule).mockReturnValue(saving.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录规则" }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "english");
    await userEvent.click(screen.getByRole("button", { name: "预览" }));
    await screen.findByText("新目录章节");
    await userEvent.click(screen.getByRole("button", { name: "应用本书" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await userEvent.click(screen.getByRole("button", { name: "目录规则" }));
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "正在应用…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    vi.mocked(app.services.reader.listToc).mockResolvedValue([chapter("保存后章节")]);
    await act(async () => saving.resolve({ mode: "english", pattern: "" }));
    await waitFor(() =>
      expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(false),
    );
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await userEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(await screen.findByRole("button", { name: "保存后章节" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "初始章节" })).toBeNull();
    expect(app.services.reader.saveTocRule).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("reader-page").getAttribute("data-start")).toBe("0");
  });

  it("rejects an old preview after closing and previewing a newer choice", async () => {
    const app = runtime();
    const oldPreview = deferred<TxtTocRulePreview>();
    vi.mocked(app.services.reader.previewTocRule).mockReturnValueOnce(oldPreview.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录规则" }));
    await userEvent.click(screen.getByRole("button", { name: "预览" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await userEvent.click(screen.getByRole("button", { name: "目录规则" }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "english");
    await userEvent.click(screen.getByRole("button", { name: "预览" }));
    await screen.findByText("新目录章节");
    await act(async () => oldPreview.resolve({ entries: [chapter("过期预览章节")] }));
    expect(screen.queryByText("过期预览章节")).toBeNull();
    expect(screen.getByText("新目录章节")).toBeTruthy();
    expect(app.services.reader.saveTocRule).not.toHaveBeenCalled();
  });

  it("retries a failed directory reload without repeating an already saved rule", async () => {
    const app = runtime();
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录规则" }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "english");
    await userEvent.click(screen.getByRole("button", { name: "预览" }));
    await screen.findByText("新目录章节");
    vi.mocked(app.services.reader.listToc).mockRejectedValueOnce(
      new Error("TOC temporarily unavailable"),
    );
    await userEvent.click(screen.getByRole("button", { name: "应用本书" }));
    expect((await screen.findByRole("alert")).textContent).toContain("规则已保存，目录读取失败");
    vi.mocked(app.services.reader.getTocRule).mockResolvedValue({ mode: "english", pattern: "" });
    vi.mocked(app.services.reader.listToc).mockResolvedValue([chapter("重试后章节")]);
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await userEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(await screen.findByRole("button", { name: "重试后章节" })).toBeTruthy();
    expect(app.services.reader.saveTocRule).toHaveBeenCalledTimes(1);
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
    await userEvent.click(screen.getByRole("button", { name: "搜索正文" }));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索关键词" }), "page");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Read a page" }));
    expect((await screen.findByTestId("reader-highlight")).textContent).toBe("page");
  });

  it("shows each page's part of a match that crosses a page boundary", async () => {
    const app = runtime();
    const boundary = paginateText(text, 0, 60)[0].endOffset;
    const start = boundary - 3;
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
    await userEvent.click(screen.getByRole("button", { name: "搜索正文" }));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索关键词" }), "page");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "跨页结果" }));
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

  it("keeps the Contents tab for the book after its panel closes", async () => {
    const app = runtime();
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录" }));
    await userEvent.click(screen.getByRole("tab", { name: "全文" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await userEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(screen.getByRole("tab", { name: "全文" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "从开头阅读" })).toBeTruthy();
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
    await userEvent.click(screen.getByRole("button", { name: "搜索正文" }));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索关键词" }), "page");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "搜索" }));
    const request = vi.mocked(app.services.reader.search).mock.calls[0][0];
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(app.services.reader.cancelSearch).toHaveBeenCalledWith(request.operationId);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "搜索正文" })),
    );
    await userEvent.click(screen.getByRole("button", { name: "搜索正文" }));
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
    const saving = deferred<TxtTocRule>();
    vi.mocked(app.services.reader.saveTocRule).mockReturnValue(saving.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录规则" }));
    await userEvent.click(screen.getByRole("button", { name: "预览" }));
    await screen.findByText("新目录章节");
    await userEvent.click(screen.getByRole("button", { name: "应用本书" }));
    let complete = false;
    const flush = app.readerFlush!().then(() => {
      complete = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(complete).toBe(false);
    await act(async () => {
      saving.resolve({ mode: "automatic", pattern: "" });
      await flush;
    });
    expect(complete).toBe(true);
  });

  it("reports a rule write failure after closing the panel and offers a working retry", async () => {
    const app = runtime();
    const saving = deferred<TxtTocRule>();
    vi.mocked(app.services.reader.saveTocRule).mockReturnValueOnce(saving.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录规则" }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "english");
    await userEvent.click(screen.getByRole("button", { name: "预览" }));
    await screen.findByText("新目录章节");
    await userEvent.click(screen.getByRole("button", { name: "应用本书" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await act(async () => saving.reject(new Error("database unavailable")));
    expect(screen.getByRole("alert").textContent).toContain("目录规则保存失败");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(app.services.reader.saveTocRule).toHaveBeenCalledTimes(2);
    expect(app.services.reader.saveTocRule).toHaveBeenLastCalledWith({
      bookId: entry.book.id,
      rule: { mode: "english", pattern: "" },
    });
  });

  it("retains a failed in-flight rule save so retrying native exit retries the write", async () => {
    const app = runtime();
    const saving = deferred<TxtTocRule>();
    vi.mocked(app.services.reader.saveTocRule).mockReturnValueOnce(saving.promise);
    await view(app);
    await userEvent.click(screen.getByRole("button", { name: "目录规则" }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "english");
    await userEvent.click(screen.getByRole("button", { name: "预览" }));
    await screen.findByText("新目录章节");
    await userEvent.click(screen.getByRole("button", { name: "应用本书" }));
    const firstFlush = app.readerFlush!().then(
      () => null,
      (error: unknown) => error,
    );
    await act(async () => {
      saving.reject(new Error("temporary write failure"));
      expect(await firstFlush).toEqual(new Error("temporary write failure"));
    });
    await act(async () => app.readerFlush!());
    expect(app.services.reader.saveTocRule).toHaveBeenCalledTimes(2);
    expect(app.services.reader.saveTocRule).toHaveBeenLastCalledWith({
      bookId: entry.book.id,
      rule: { mode: "english", pattern: "" },
    });
  });
});

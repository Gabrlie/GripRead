// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type { LibraryBook } from "../../types/generated";
import { sourceServiceMocks } from "../../test/sources";
import { OfflineCachePage } from "../Bookshelf/OfflineCachePage";
import { CacheManagerPage } from "./CacheManagerPage";

afterEach(cleanup);

function onlineBook(id: string, title: string, readChapter: number | null): LibraryBook {
  return {
    book: { id, title, author: null, contentVersion: "v", createdAt: 1, updatedAt: 1 },
    asset: null,
    locator: null,
    totalLength: null,
    txtEncoding: null,
    lastReadAt: null,
    removedAt: null,
    shelfState: null,
    coverAssetId: null,
    useReplaceRules: true,
    inCloud: false,
    online: {
      book: {
        sourceUrl: "https://a.com",
        sourceName: "甲站",
        name: title,
        author: "",
        kind: "",
        coverUrl: "",
        intro: "",
        wordCount: "",
        latestChapterTitle: "",
        bookUrl: `https://a.com/${id}`,
        tocUrl: "",
        variables: "",
        reverseToc: false,
      },
      totalChapters: 200,
      newChapters: 0,
      lastCheckTime: null,
      updateError: null,
      canUpdate: true,
      onShelf: true,
      readChapter,
      readChapterTitle: "",
      cachedChapters: 0,
    },
  } as unknown as LibraryBook;
}

function runtimeWith(books: LibraryBook[]) {
  const sources = sourceServiceMocks();
  const runtime = new AppRuntime({
    library: {
      listBooks: vi.fn(async () => books),
      listRemovedBooks: vi.fn(async () => []),
      onImportProgress: vi.fn(async () => () => undefined),
    },
    reader: {},
    settings: {},
    sync: {},
    sources,
  } as unknown as AppServices);
  return { runtime, sources };
}

describe("缓存管理", () => {
  it("shows the total and clears the chapter cache", async () => {
    const { runtime, sources } = runtimeWith([]);
    vi.mocked(sources.storageUsage).mockResolvedValue({
      parts: [
        { key: "books", label: "本地书籍", bytes: 2 * 1024 * 1024 },
        { key: "chapters", label: "章节缓存", bytes: 1024 * 1024 },
      ],
      books: [],
    });
    render(
      <RuntimeContext.Provider value={runtime}>
        <CacheManagerPage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    expect(await screen.findByText("3.0 MB")).toBeTruthy();
    const row = screen.getByText("章节缓存").parentElement!;
    await userEvent.click(within(row).getByRole("button", { name: "清除" }));
    await vi.waitFor(() => expect(sources.clearAllOnlineCaches).toHaveBeenCalledOnce());
  });
});

describe("离线缓存", () => {
  it("runs two books at a time from where each is read", async () => {
    const books = [
      onlineBook("a", "甲书", 10),
      onlineBook("b", "乙书", null),
      onlineBook("c", "丙书", 0),
    ];
    const { runtime, sources } = runtimeWith(books);
    vi.mocked(sources.cacheChapters).mockImplementation(async () => undefined);
    await runtime.library.refresh();
    render(
      <RuntimeContext.Provider value={runtime}>
        <OfflineCachePage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "全选" }));
    await userEvent.click(screen.getByRole("button", { name: "后面 50 章" }));
    expect(sources.cacheChapters).toHaveBeenCalledTimes(2);
    expect(sources.cacheChapters).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: "a", start: 10, end: 60 }),
    );
    expect(screen.getByText(/等待中/)).toBeTruthy();
  });
});

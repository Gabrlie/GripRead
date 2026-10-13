// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type { LibraryBook } from "../../types/generated";
import { sourceServiceMocks } from "../../test/sources";
import { OfflineCachePage } from "../Bookshelf/OfflineCachePage";
import { DataManagerPage } from "./DataManagerPage";

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

describe("数据管理", () => {
  it("chooses the caches except the shelf's chapters and clears them", async () => {
    const { runtime, sources } = runtimeWith([]);
    vi.mocked(sources.dataUsage).mockResolvedValue({
      parts: [
        { key: "unshelved", label: "未加入书架的网络书籍", bytes: 1024 * 1024, clearable: true },
        { key: "shelved", label: "书架书籍的章节缓存", bytes: 4 * 1024 * 1024, clearable: true },
        { key: "covers", label: "封面缓存", bytes: 1024 * 1024, clearable: true },
        { key: "books", label: "本地书籍", bytes: 8 * 1024 * 1024, clearable: false },
      ],
      books: [{ bookId: "a", title: "甲书", bytes: 4096, cachedChapters: 12, totalChapters: 300 }],
    });
    render(
      <RuntimeContext.Provider value={runtime}>
        <DataManagerPage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    const clear = await screen.findByRole("button", { name: "清理所选（2.0 MB）" });
    expect(
      screen.getByRole("checkbox", { name: "书架书籍的章节缓存" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText(/已缓存 12\/300 章/)).toBeTruthy();
    expect(screen.queryByText(/应用占用/)).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "封面缓存" }));
    expect(screen.getByRole("button", { name: "清理所选（1.0 MB）" })).toBe(clear);
    await userEvent.click(clear);
    await vi.waitFor(() => expect(sources.clearData).toHaveBeenCalledWith(["unshelved"]));
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

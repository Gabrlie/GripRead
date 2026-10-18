// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type { DownloadJob, LibraryBook } from "../../types/generated";
import { sourceServiceMocks } from "../../test/sources";
import { CacheRangeDialog } from "../Online/CacheRangeDialog";
import { DownloadManagerPage } from "./DownloadManagerPage";

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
        comic: false,
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
    reader: { listToc: vi.fn(async () => ({ entries: [] })) },
    settings: {},
    sync: {},
    sources,
  } as unknown as AppServices);
  return { runtime, sources };
}
describe("下载管理", () => {
  it("adds chosen books from where each is read and lists the jobs", async () => {
    const books = [onlineBook("a", "甲书", 10), onlineBook("b", "乙书", null)];
    const { runtime, sources } = runtimeWith(books);
    let listener: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(sources.onDownloads).mockImplementation(async (next) => {
      listener = next;
      return () => undefined;
    });
    await runtime.library.refresh();
    render(
      <RuntimeContext.Provider value={runtime}>
        <DownloadManagerPage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    expect(await screen.findByText(/没有下载任务/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    await userEvent.click(screen.getByRole("button", { name: "全选" }));
    await userEvent.click(screen.getByRole("button", { name: "后面 50 章" }));
    expect(sources.enqueueDownload).toHaveBeenCalledWith("a", 10, 60);
    expect(sources.enqueueDownload).toHaveBeenCalledWith("b", 0, 50);
    const job: DownloadJob = {
      id: "j",
      bookId: "a",
      title: "甲书",
      start: 10,
      end: 60,
      state: "running",
      cached: 5,
      failed: 1,
      total: 50,
      createdAt: 1,
    };
    listener!([job]);
    const list = await screen.findByRole("list", { name: "下载任务" });
    expect(within(list).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("6");
    await userEvent.click(within(list).getByRole("button", { name: "暂停" }));
    expect(sources.pauseDownload).toHaveBeenCalledWith("j");
  });
});

describe("选择章节缓存", () => {
  it("queues a custom range by chapter number", async () => {
    const book = onlineBook("a", "甲书", 3);
    const { runtime, sources } = runtimeWith([book]);
    render(
      <RuntimeContext.Provider value={runtime}>
        <CacheRangeDialog book={book} onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    const from = screen.getByRole("textbox", { name: "从第几章" });
    expect((from as HTMLInputElement).value).toBe("4");
    await userEvent.clear(screen.getByRole("textbox", { name: "到第几章" }));
    await userEvent.type(screen.getByRole("textbox", { name: "到第几章" }), "120");
    await userEvent.click(screen.getByRole("button", { name: "缓存第 4–120 章" }));
    expect(sources.enqueueDownload).toHaveBeenCalledWith("a", 3, 120);
  });
});

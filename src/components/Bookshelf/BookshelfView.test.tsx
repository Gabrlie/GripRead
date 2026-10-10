// @vitest-environment jsdom
import React from "react";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BookshelfView } from "./BookshelfView";
import { ImportModal } from "./ImportModal";
import { AppProvider } from "../../context/AppContext";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type { ImportStatus, LibraryBook } from "../../types/generated";
import { ruleServiceMocks, tocEntry, tocListing, fontServiceMocks } from "../../test/toc";
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});
beforeAll(() => {
  window.scrollTo = vi.fn();
});
const entry: LibraryBook = {
  book: {
    id: "real-book",
    title: "真实文本",
    author: null,
    contentVersion: "v1",
    createdAt: 1,
    updatedAt: 1,
  },
  asset: {
    id: "a",
    bookId: "real-book",
    kind: "txt",
    sha256: "h",
    byteLength: 20,
    contentVersion: "v1",
    availability: "ready",
    createdAt: 1,
  },
  locator: null,
  totalLength: 10,
  txtEncoding: null,
  lastReadAt: null,
  removedAt: null,
};
function runtime(books: LibraryBook[] = []) {
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
      listBooks: vi.fn(async () => books),
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
      getTxtEncoding: vi.fn(),
      pickAndReassociateTxt: vi.fn(async () => null),
      reassociateTxtSource: vi.fn(),
    },
    reader: {
      readContentWindow: vi.fn(),
      resolveLocator: vi.fn(),
      resolveOffset: vi.fn(),
      saveReaderLocator: vi.fn(),
      getSavedReaderLocator: vi.fn(),
      listToc: vi.fn(async () => tocListing()),
      ...ruleServiceMocks(),
      listBookmarks: vi.fn(async () => []),
      addBookmark: vi.fn(),
      deleteBookmark: vi.fn(),
      search: vi.fn(),
      cancelSearch: vi.fn(),
    },
    settings: {
      getSettings: vi.fn(),
      saveSettings: vi.fn(),
      getShelfPreferences: vi.fn(async () => ({
        layout: "list" as const,
        sort: "recent_read" as const,
        groupId: "all",
      })),
      saveShelfPreferences: vi.fn(async (value) => value),
      ...fontServiceMocks(),
    },
  } satisfies AppServices);
}
function view(app: AppRuntime) {
  render(
    <RuntimeContext.Provider value={app}>
      <AppProvider>
        <BookshelfView />
        <ImportModal />
      </AppProvider>
    </RuntimeContext.Provider>,
  );
}
describe("real library presentation", () => {
  it("shows the backend empty state and invokes native import", async () => {
    const app = runtime();
    await app.library.refresh();
    view(app);
    expect(screen.getByText("从一本本地小说开始")).toBeTruthy();
    expect(screen.queryByText("宿命之环")).toBeNull();
    await userEvent.click(screen.getByTestId("import-button"));
    expect(app.services.library.pickAndImportTxt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText("关闭导入提示")).toBeNull();
  });
  it("imports silently and opens optional progress from the import entry", async () => {
    vi.useFakeTimers();
    const app = runtime();
    vi.mocked(app.services.library.pickAndImportTxt).mockResolvedValue({ operationId: "active" });
    vi.mocked(app.services.library.getImportStatus).mockResolvedValue({
      operationId: "active",
      phase: "reading",
      bytesRead: 5,
      totalBytes: 10,
      result: null,
      error: null,
    });
    await app.library.refresh();
    view(app);
    await act(async () => fireEvent.click(screen.getByTestId("import-button")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "查看导入进度" }).textContent).toContain("50%");
    await act(async () => fireEvent.click(screen.getByTestId("import-button")));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(app.services.library.pickAndImportTxt).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(app.library.getSnapshot().importing).toBe(true);
    expect(app.services.library.cancelImport).not.toHaveBeenCalled();
  });
  it("recovers an expired decoding failure through the import entry and selected encoding", async () => {
    vi.useFakeTimers();
    const app = runtime();
    const failed: ImportStatus = {
      operationId: "failed",
      phase: "failed",
      bytesRead: 10,
      totalBytes: 10,
      result: null,
      error: { code: "unsupported_encoding", message: "无法识别文本编码" },
    };
    vi.mocked(app.services.library.pickAndImportTxt)
      .mockResolvedValueOnce({ operationId: "failed" })
      .mockResolvedValueOnce({ operationId: "retried" });
    vi.mocked(app.services.library.getImportStatus)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce({
        ...failed,
        operationId: "retried",
        phase: "completed",
        error: null,
        result: {
          book: entry.book,
          asset: entry.asset,
          duplicate: false,
          sourceByteLength: 10,
        },
      });
    await app.library.refresh();
    view(app);
    await act(async () => fireEvent.click(screen.getByTestId("import-button")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("导入失败 · 查看详情")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(screen.queryByText("导入失败 · 查看详情")).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId("import-button")));
    expect(screen.getByRole("alert").textContent).toContain("无法识别文本编码");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "gbk" } });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "选择文件并按编码重试" })),
    );
    expect(app.services.library.pickAndImportTxt).toHaveBeenLastCalledWith("gbk");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("导入完成：真实文本")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.queryByText("导入完成：真实文本")).toBeNull();
    expect(app.library.getSnapshot().importOutcome?.phase).toBe("completed");
  });
  it("keeps a notice while hovered or focused and expires it after both interactions end", async () => {
    vi.useFakeTimers();
    const app = runtime();
    vi.mocked(app.services.library.startImport).mockRejectedValue(new Error("disk unavailable"));
    await app.library.refresh();
    view(app);
    await act(() => app.library.importTxt("/book.txt"));
    const notice = screen.getByText("导入失败 · 查看详情");
    fireEvent.pointerEnter(notice);
    fireEvent.focus(notice);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    fireEvent.pointerLeave(notice);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByText("导入失败 · 查看详情")).toBeTruthy();
    fireEvent.blur(notice, { relatedTarget: document.body });
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(screen.queryByText("导入失败 · 查看详情")).toBeNull();
  });
  it("does not show an empty shelf action while the initial snapshot is loading", async () => {
    let resolve!: (books: LibraryBook[]) => void;
    const app = runtime();
    vi.mocked(app.services.library.listBooks).mockReturnValue(
      new Promise<LibraryBook[]>((res) => {
        resolve = res;
      }),
    );
    view(app);
    expect(screen.queryByText("从一本本地小说开始")).toBeNull();
    const refresh = app.library.refresh();
    resolve([entry]);
    await refresh;
    await waitFor(() => expect(screen.getByTestId("library-book-real-book")).toBeTruthy());
  });
  it("displays real metadata without invented chapters or ratings", async () => {
    const app = runtime([entry]);
    await app.library.refresh();
    view(app);
    expect(screen.getByTestId("library-book-real-book")).toBeTruthy();
    expect(screen.getByText("作者未知")).toBeTruthy();
    expect(screen.queryByText("全本完结")).toBeNull();
  });
  it("opens book information with the introduction on a long press or right-click", async () => {
    const app = runtime([entry]);
    vi.mocked(app.services.library.getBookInfo).mockResolvedValue({
      bookId: entry.book.id,
      intro: "前言里的一段简介。",
      sourceByteLength: 4096,
      chapterCount: 12,
    });
    await app.library.refresh();
    view(app);
    fireEvent.contextMenu(screen.getByTestId("library-book-real-book"));
    expect(await screen.findByText("前言里的一段简介。")).toBeTruthy();
    expect(screen.getByText("12 章")).toBeTruthy();
    expect(screen.getByText("4 KB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始阅读" })).toBeTruthy();
  });

  it("makes a database failure visible and permits retry", async () => {
    const app = runtime();
    vi.mocked(app.services.library.listBooks).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await app.library.refresh();
    view(app);
    expect(screen.getByRole("alert").textContent).toContain("database unavailable");
    await userEvent.click(screen.getByText("重试"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("does not repopulate an empty group snapshot or attach a remote cover by title", async () => {
    const app = runtime([{ ...entry, book: { ...entry.book, title: "宿命之环" } }]);
    await app.library.refresh();
    view(app);
    await waitFor(() => expect(app.shelf.getSnapshot().loading).toBe(false));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.trim())).toEqual(["全部"]);
    expect(document.querySelector('img[src^="https:"]')).toBeNull();
    expect(screen.queryByText("今日 42 分钟")).toBeNull();
  });

  it("exposes a chapter failure and retries without hiding the book", async () => {
    const app = runtime([entry]);
    vi.mocked(app.services.reader.listToc).mockRejectedValueOnce(new Error("cannot read TOC"));
    await app.library.refresh();
    view(app);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("目录读取失败"));
    expect(screen.getByTestId("library-book-real-book")).toBeTruthy();
    await userEvent.click(screen.getByText("重试"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("manages shelf-hide-scrollbar class on mount and unmount", async () => {
    const app = runtime();
    await app.library.refresh();
    const { unmount } = render(
      <RuntimeContext.Provider value={app}>
        <AppProvider>
          <BookshelfView />
        </AppProvider>
      </RuntimeContext.Provider>,
    );
    expect(document.documentElement.classList.contains("shelf-hide-scrollbar")).toBe(true);
    expect(document.body.classList.contains("shelf-hide-scrollbar")).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains("shelf-hide-scrollbar")).toBe(false);
    expect(document.body.classList.contains("shelf-hide-scrollbar")).toBe(false);
  });

  it("connects sorting, metadata editing, removal, and restoration to the real services", async () => {
    const app = runtime([entry]);
    let active = true;
    vi.mocked(app.services.library.listBooks).mockImplementation(async () =>
      active ? [entry] : [],
    );
    vi.mocked(app.services.library.listRemovedBooks).mockImplementation(async () =>
      active ? [] : [entry],
    );
    vi.mocked(app.services.library.removeBook).mockImplementation(async () => {
      active = false;
    });
    vi.mocked(app.services.library.restoreBook).mockImplementation(async () => {
      active = true;
    });
    await app.library.refresh();
    await app.shelfPreferences.load();
    view(app);

    await userEvent.click(screen.getByRole("button", { name: "更多选项" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "书架排序" })).toBeTruthy());
    await userEvent.click(screen.getByRole("menuitem", { name: "书架排序" }));
    await userEvent.click(screen.getByRole("button", { name: /书名/ }));
    await waitFor(() =>
      expect(app.services.settings.saveShelfPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ sort: "title" }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));

    await userEvent.click(screen.getByRole("button", { name: "更多选项" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "书籍管理" })).toBeTruthy());
    await userEvent.click(screen.getByRole("menuitem", { name: "书籍管理" }));
    const title = screen.getByRole("textbox", { name: "书名" });
    await userEvent.clear(title);
    await userEvent.type(title, "已编辑");
    await userEvent.click(screen.getByRole("button", { name: "保存信息" }));
    await waitFor(() =>
      expect(app.services.library.updateBook).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: entry.book.id, title: "已编辑" }),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "移出书架" }));
    await waitFor(() =>
      expect(app.services.library.removeBook).toHaveBeenCalledWith(entry.book.id),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "更多选项" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "已移出书籍" })).toBeTruthy());
    await userEvent.click(screen.getByRole("menuitem", { name: "已移出书籍" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /恢复/ })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /恢复/ }));
    await waitFor(() =>
      expect(app.services.library.restoreBook).toHaveBeenCalledWith(entry.book.id),
    );
  });
});

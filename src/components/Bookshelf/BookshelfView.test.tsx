// @vitest-environment jsdom
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BookshelfView } from "./BookshelfView";
import { AppProvider } from "../../context/AppContext";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type { LibraryBook } from "../../types/generated";
afterEach(cleanup);
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
      getTxtEncoding: vi.fn(),
      pickAndReassociateTxt: vi.fn(async () => null),
      reassociateTxtSource: vi.fn(),
    },
    reader: {
      readContentWindow: vi.fn(),
      resolveLocator: vi.fn(),
      saveReaderLocator: vi.fn(),
      getSavedReaderLocator: vi.fn(),
      listToc: vi.fn(async () => []),
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
    },
  } satisfies AppServices);
}
function view(app: AppRuntime) {
  render(
    <RuntimeContext.Provider value={app}>
      <AppProvider>
        <BookshelfView />
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

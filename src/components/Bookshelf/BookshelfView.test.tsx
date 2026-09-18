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
};
function runtime(books: LibraryBook[] = []) {
  return new AppRuntime({
    library: {
      listBooks: vi.fn(async () => books),
      pickAndImportTxt: vi.fn(async () => null),
      startImport: vi.fn(),
      cancelImport: vi.fn(),
      getImportStatus: vi.fn(),
      onImportProgress: vi.fn(async () => () => {}),
    },
    reader: {
      readContentWindow: vi.fn(),
      resolveLocator: vi.fn(),
      saveReaderLocator: vi.fn(),
      getSavedReaderLocator: vi.fn(),
    },
    settings: { getSettings: vi.fn(), saveSettings: vi.fn() },
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
});

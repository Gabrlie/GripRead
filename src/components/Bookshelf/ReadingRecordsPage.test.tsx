// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { sourceServiceMocks } from "../../test/sources";
import { ReadingRecordsPage } from "./ReadingRecordsPage";

afterEach(cleanup);

describe("阅读记录", () => {
  it("keeps deleted books and says they cannot be opened", async () => {
    const runtime = new AppRuntime({
      library: {
        listBooks: vi.fn(async () => []),
        listRemovedBooks: vi.fn(async () => []),
        onImportProgress: vi.fn(async () => () => undefined),
        readingStats: vi.fn(async () => ({
          totalSeconds: 3600,
          todaySeconds: 0,
          days: [{ day: "2026-10-01", seconds: 3600 }],
          books: [
            {
              bookId: "retired:abc",
              seconds: 3600,
              lastDay: "2026-10-01",
              title: "删掉的书",
              author: null,
              deleted: true,
              lastReadAt: 1,
            },
          ],
        })),
      },
      reader: {},
      settings: {},
      sync: {},
      sources: sourceServiceMocks(),
    } as unknown as AppServices);
    const onOpenBook = vi.fn();
    render(
      <RuntimeContext.Provider value={runtime}>
        <ReadingRecordsPage onClose={() => undefined} onOpenBook={onOpenBook} />
      </RuntimeContext.Provider>,
    );
    expect(await screen.findByRole("grid", { name: "阅读活跃" })).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: /删掉的书/ }));
    expect(await screen.findByText(/这本书已删除，无法打开/)).toBeTruthy();
    expect(onOpenBook).not.toHaveBeenCalled();
  });
});

describe("删除阅读记录", () => {
  it("removes a record after a long press and a confirmation", async () => {
    const remove = vi.fn(async () => undefined);
    const stats = vi.fn(async () => ({
      totalSeconds: 600,
      todaySeconds: 0,
      days: [{ day: "2026-10-01", seconds: 600 }],
      books: [
        {
          bookId: "retired:abc",
          seconds: 600,
          lastDay: "2026-10-01",
          title: "删掉的书",
          author: null,
          deleted: true,
          lastReadAt: 1,
        },
      ],
    }));
    const runtime = new AppRuntime({
      library: {
        listBooks: vi.fn(async () => []),
        listRemovedBooks: vi.fn(async () => []),
        onImportProgress: vi.fn(async () => () => undefined),
        readingStats: stats,
        deleteReadingRecord: remove,
      },
      reader: {},
      settings: {},
      sync: {},
      sources: sourceServiceMocks(),
    } as unknown as AppServices);
    render(
      <RuntimeContext.Provider value={runtime}>
        <ReadingRecordsPage onClose={() => undefined} onOpenBook={() => undefined} />
      </RuntimeContext.Provider>,
    );
    const row = await screen.findByRole("button", { name: /删掉的书/ });
    fireEvent.contextMenu(row);
    await userEvent.click(await screen.findByRole("button", { name: "删除" }));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("retired:abc"));
    await vi.waitFor(() => expect(stats).toHaveBeenCalledTimes(2));
  });
});

describe("private groups in 阅读记录", () => {
  it("leaves out a locked private group's books and lists them once it is opened", async () => {
    const record = (bookId: string, title: string) => ({
      bookId,
      seconds: 600,
      lastDay: "2026-10-01",
      title,
      author: null,
      deleted: true,
      lastReadAt: 1,
    });
    const runtime = new AppRuntime({
      library: {
        listBooks: vi.fn(async () => []),
        listRemovedBooks: vi.fn(async () => []),
        onImportProgress: vi.fn(async () => () => undefined),
        listGroups: vi.fn(async () => [
          {
            id: "p",
            name: "私密",
            bookIds: ["secret"],
            privacy: { lock: "mask", sync: true },
          },
        ]),
        readingStats: vi.fn(async () => ({
          totalSeconds: 1200,
          todaySeconds: 0,
          days: [{ day: "2026-10-01", seconds: 1200 }],
          books: [record("plain", "普通的书"), record("secret", "秘密之书")],
        })),
      },
      reader: { listToc: vi.fn() },
      settings: {},
      sync: {},
      sources: sourceServiceMocks(),
    } as unknown as AppServices);
    await runtime.shelf.load([]);
    render(
      <RuntimeContext.Provider value={runtime}>
        <ReadingRecordsPage onClose={() => undefined} onOpenBook={() => undefined} />
      </RuntimeContext.Provider>,
    );
    expect(await screen.findByRole("button", { name: /普通的书/ })).toBeTruthy();
    expect(screen.queryByText("秘密之书")).toBeNull();
    await act(() => runtime.shelf.unlock("p"));
    expect(await screen.findByRole("button", { name: /秘密之书/ })).toBeTruthy();
  });
});

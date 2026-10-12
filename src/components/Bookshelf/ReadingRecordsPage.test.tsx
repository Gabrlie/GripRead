// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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

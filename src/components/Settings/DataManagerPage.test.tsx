// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type { LibraryBook } from "../../types/generated";
import { sourceServiceMocks } from "../../test/sources";
import { DataManagerPage } from "./DataManagerPage";

afterEach(cleanup);

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
    expect(screen.getByText("6.0 MB")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "封面缓存" }));
    expect(screen.getByRole("button", { name: "清理所选（1.0 MB）" })).toBe(clear);
    await userEvent.click(clear);
    await vi.waitFor(() => expect(sources.clearData).toHaveBeenCalledWith(["unshelved"]));
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { createMemorySourceService, PREVIEW_BOOKS, PREVIEW_SOURCES } from "../../preview/sources";
import { DiscoverView } from "../Discover/DiscoverView";
import { SearchPage } from "./SearchPage";

afterEach(cleanup);

function service() {
  return createMemorySourceService(PREVIEW_SOURCES, PREVIEW_BOOKS);
}

describe("online search", () => {
  it("shows merged results as sources answer and opens a book with its sources", async () => {
    const sources = service();
    const search = vi.spyOn(sources, "search");
    render(<SearchPage service={sources} onClose={() => undefined} />);
    await userEvent.type(screen.getByRole("textbox", { name: "书名或作者" }), "剑来");
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "剑来",
        precise: false,
        scope: { groups: [], sourceUrls: [] },
      }),
    );
    const results = await screen.findByRole("list", { name: "搜索结果" });
    expect(await within(results).findByText("2 个书源")).toBeTruthy();
    expect(await screen.findByText("2 个书源，找到 2 本")).toBeTruthy();
    await userEvent.click(within(results).getAllByRole("button")[0]);
    expect(await screen.findByRole("dialog", { name: "书籍详情" })).toBeTruthy();
    expect(await screen.findByText("换源（2）")).toBeTruthy();
    expect(await screen.findByText("目录（23 章）")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "目录" }));
    const toc = await screen.findByRole("dialog", { name: "目录" });
    expect(within(toc).getByText("共 23 章")).toBeTruthy();
    await userEvent.click(within(toc).getByRole("button", { name: "返回" }));
    expect(screen.queryByRole("dialog", { name: "目录" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "试读" }));
    expect(await screen.findByText(/第1章 剑来的第1章的第 1 段预览正文/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "下一章" }));
    expect(await screen.findByText(/第2章 剑来的第2章的第 1 段预览正文/)).toBeTruthy();
  });

  it("keeps the keyword history and searches a remembered keyword", async () => {
    localStorage.setItem("gripread.onlineSearchHistory", JSON.stringify(["雪中"]));
    const sources = service();
    render(<SearchPage service={sources} onClose={() => undefined} />);
    await userEvent.click(
      within(screen.getByRole("region", { name: "搜索历史" })).getByText("雪中"),
    );
    const results = await screen.findByRole("list", { name: "搜索结果" });
    expect((await within(results).findAllByText("雪中悍刀行")).length).toBeGreaterThan(0);
  });
});

describe("发现", () => {
  it("expands a source into categories and opens a category's books", async () => {
    const sources = service();
    const runtime = new AppRuntime({
      library: {
        listBooks: vi.fn(async () => []),
        listRemovedBooks: vi.fn(async () => []),
        onImportProgress: vi.fn(async () => () => undefined),
      },
      reader: {},
      settings: {
        getSettings: vi.fn(async () => {
          throw new Error("unused");
        }),
        getShelfPreferences: vi.fn(async () => {
          throw new Error("unused");
        }),
      },
      sync: {},
      sources,
    } as unknown as AppServices);
    render(
      <RuntimeContext.Provider value={runtime}>
        <DiscoverView />
      </RuntimeContext.Provider>,
    );
    const list = await screen.findByRole("list", { name: "发现书源" });
    expect(within(list).queryByText("乙站 API")).toBeNull();
    await userEvent.click(within(list).getByRole("button", { name: "甲站小说" }));
    await userEvent.click(await screen.findByRole("button", { name: "都市" }));
    expect(await screen.findByRole("dialog", { name: "甲站小说 · 都市" })).toBeTruthy();
    const books = await screen.findByRole("list", { name: "书籍" });
    expect((await within(books).findAllByText("剑来外传")).length).toBeGreaterThan(0);
  });
});

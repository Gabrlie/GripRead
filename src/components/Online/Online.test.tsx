// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { createMemorySourceService, PREVIEW_BOOKS, PREVIEW_SOURCES } from "../../preview/sources";
import { DiscoverView } from "../Discover/DiscoverView";
import { SearchPage } from "./SearchPage";
import { ChangeSourceDialog } from "./ChangeSourceDialog";
import { SourceDetailsDialog } from "./SourceDetailsDialog";

afterEach(cleanup);

function service() {
  return createMemorySourceService(PREVIEW_SOURCES, PREVIEW_BOOKS);
}

describe("online search", () => {
  it("shows merged results as sources answer and opens a book with its sources", async () => {
    const sources = service();
    const search = vi.spyOn(sources, "search");
    const add = vi.spyOn(sources, "addOnlineBook");
    const onRead = vi.fn();
    render(<SearchPage service={sources} onRead={onRead} onClose={() => undefined} />);
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
    await userEvent.click(await screen.findByRole("button", { name: /目录（23 章）/ }));
    const toc = await screen.findByRole("dialog", { name: "目录" });
    expect(within(toc).getByText("共 23 章")).toBeTruthy();
    // The Android back gesture arrives as Escape.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "目录" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "书籍详情" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "加入书架" }));
    expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ onShelf: true }));
    expect(await screen.findByRole("button", { name: "移出书架" })).toBeTruthy();
    expect(screen.getByText("已在书架")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "阅读" }));
    await vi.waitFor(() => expect(onRead).toHaveBeenCalledOnce());
    const [book, chapter, from] = onRead.mock.calls[0];
    expect(book.online.onShelf).toBe(true);
    expect(chapter).toBeNull();
    expect(from).toMatchObject({ view: "search", key: "剑来", origin: 0 });
    expect(from.event.results.length).toBe(2);
  });

  it("reads a chapter chosen in the contents without adding the book", async () => {
    const sources = service();
    const add = vi.spyOn(sources, "addOnlineBook");
    const onRead = vi.fn();
    render(<SearchPage service={sources} onRead={onRead} onClose={() => undefined} />);
    await userEvent.type(screen.getByRole("textbox", { name: "书名或作者" }), "雪中");
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));
    const results = await screen.findByRole("list", { name: "搜索结果" });
    await userEvent.click((await within(results).findAllByRole("button"))[0]);
    await userEvent.click(await screen.findByRole("button", { name: /目录（23 章）/ }));
    const toc = await screen.findByRole("dialog", { name: "目录" });
    await userEvent.click(within(toc).getByRole("button", { name: /第3章/ }));
    await vi.waitFor(() => expect(onRead).toHaveBeenCalledOnce());
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ onShelf: false }));
    expect(onRead.mock.calls[0][1]).toBe(3);
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
    const sources = createMemorySourceService(
      [
        ...PREVIEW_SOURCES,
        {
          bookSourceUrl: "https://off.example.com",
          bookSourceName: "已禁用的站",
          enabled: false,
          exploreUrl: "玄幻::/x",
        },
      ],
      PREVIEW_BOOKS,
    );
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
    expect(within(list).queryByText("已禁用的站")).toBeNull();
    await userEvent.click(within(list).getByRole("button", { name: "甲站小说" }));
    await userEvent.click(await screen.findByRole("button", { name: "都市" }));
    expect(await screen.findByRole("dialog", { name: "甲站小说 · 都市" })).toBeTruthy();
    const books = await screen.findByRole("list", { name: "书籍" });
    expect((await within(books).findAllByText("剑来外传")).length).toBeGreaterThan(0);
  });
});

describe("换源", () => {
  it("lists the other sources with the same book and moves the book to the chosen one", async () => {
    const sources = service();
    const kept = await sources.addOnlineBook({
      book: PREVIEW_BOOKS[0],
      chapters: await sources.chapters(PREVIEW_BOOKS[0]),
      onShelf: true,
    });
    const change = vi.spyOn(sources, "changeSource");
    const onChanged = vi.fn();
    render(
      <ChangeSourceDialog
        service={sources}
        book={kept}
        onChanged={onChanged}
        onClose={() => undefined}
      />,
    );
    const list = await screen.findByRole("list", { name: "可换的书源" });
    // 剑来外传 has a different name and stays out.
    expect(await within(list).findByText("乙站 API")).toBeTruthy();
    // Each candidate's details and contents load to show its latest chapter and size.
    expect(await within(list).findByText(/第一千章 终 · 23 章/)).toBeTruthy();
    expect(within(list).queryByText(/剑来外传/)).toBeNull();
    const current = within(list).getByText("甲站小说").closest("button")!;
    expect(current.hasAttribute("disabled")).toBe(true);
    await userEvent.click(within(list).getByText("乙站 API"));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: kept.book.id,
        book: expect.objectContaining({ sourceUrl: "https://api.example-b.com" }),
      }),
    );
  });
});

describe("从书源选择封面", () => {
  it("offers the copies with a cover and keeps the chosen one", async () => {
    const sources = createMemorySourceService(
      PREVIEW_SOURCES,
      PREVIEW_BOOKS.map((book, index) => ({
        ...book,
        coverUrl: index === 1 ? "https://b/c.jpg" : "",
      })),
    );
    const onCover = vi.fn(async () => undefined);
    render(
      <SourceDetailsDialog
        service={sources}
        title="剑来"
        author="烽火戏诸侯"
        onCover={onCover}
        onClose={() => undefined}
      />,
    );
    const list = await screen.findByRole("list", { name: "书源里的这本书" });
    expect(await within(list).findByText("乙站 API")).toBeTruthy();
    // Copies without a cover are left out.
    expect(within(list).queryByText("甲站小说")).toBeNull();
    await userEvent.click(within(list).getByRole("button", { name: "用这个封面" }));
    await vi.waitFor(() => expect(onCover).toHaveBeenCalledOnce());
    expect(onCover.mock.calls[0]).toEqual([
      expect.objectContaining({ coverUrl: "https://b/c.jpg" }),
    ]);
  });
});

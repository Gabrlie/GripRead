// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { feedServiceMocks } from "../../test/rss";
import { RssView } from "./RssView";

afterEach(cleanup);
beforeEach(() => {
  // jsdom has no media queries: the phone layout.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }) as never;
});

function page(seed = true) {
  const feeds = feedServiceMocks(seed);
  const runtime = new AppRuntime({
    library: {},
    reader: {},
    settings: { getShelfPreferences: vi.fn(), saveShelfPreferences: vi.fn() },
    sync: {},
    sources: {},
    updates: {},
    feeds,
  } as unknown as AppServices);
  render(
    <RuntimeContext.Provider value={runtime}>
      <RssView />
    </RuntimeContext.Provider>,
  );
  return { feeds, runtime };
}

describe("订阅", () => {
  it("opens a feed's articles, then an article, which is marked read", async () => {
    const { feeds } = page();
    const list = await screen.findByRole("navigation", { name: "订阅列表" });
    await userEvent.click(within(list).getByRole("button", { name: /每日新闻/ }));
    const articles = await screen.findByRole("dialog", { name: "每日新闻" });
    const first = await within(articles).findByText("每日新闻 · 第 1 篇");
    await userEvent.click(first);
    const article = await screen.findByRole("article", { name: "每日新闻 · 第 1 篇" });
    expect(within(article).getByText("每日新闻 · 第 1 篇的正文。")).toBeTruthy();
    await waitFor(() =>
      expect(feeds.setArticleState).toHaveBeenCalledWith([expect.any(String)], { read: true }),
    );
    await userEvent.click(within(article).getByRole("button", { name: "星标" }));
    expect(feeds.setArticleState).toHaveBeenLastCalledWith([expect.any(String)], { starred: true });
    await userEvent.click(within(article).getByRole("button", { name: "全文" }));
    expect(await within(article).findByText("（全文）")).toBeTruthy();
  });

  it("finds a feed at an address and subscribes to it", async () => {
    const { feeds } = page(false);
    await userEvent.click((await screen.findAllByRole("button", { name: "添加订阅" }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "添加订阅" });
    await userEvent.type(within(dialog).getByLabelText("订阅地址"), "https://new.example/feed");
    await userEvent.click(within(dialog).getByRole("button", { name: "查找" }));
    await userEvent.type(await within(dialog).findByLabelText("分组"), "新分组");
    await userEvent.click(within(dialog).getByRole("button", { name: "订阅" }));
    await waitFor(() =>
      expect(feeds.addFeed).toHaveBeenCalledWith(
        "https://new.example/feed",
        "new.example",
        "新分组",
      ),
    );
    const list = await screen.findByRole("navigation", { name: "订阅列表" });
    expect(await within(list).findByRole("button", { name: "收起 新分组" })).toBeTruthy();
  });

  it("filters to starred articles", async () => {
    page();
    const list = await screen.findByRole("navigation", { name: "订阅列表" });
    await userEvent.click(within(list).getByRole("button", { name: /全部文章/ }));
    const articles = await screen.findByRole("dialog", { name: "全部文章" });
    await userEvent.click(within(articles).getByRole("tab", { name: "星标" }));
    await waitFor(() => {
      const rows = within(articles).getAllByRole("listitem");
      expect(rows.length).toBe(3);
    });
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { feedServiceMocks } from "../../test/rss";
import { FeedManagePage } from "./FeedManagePage";
import { RssSettingsPage } from "./RssSettingsPage";
import { RssView } from "./RssView";

afterEach(cleanup);
beforeEach(() => {
  // jsdom has no media queries: the phone layout.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }) as never;
  // jsdom makes no object URLs: pictures get a stand-in.
  URL.createObjectURL = vi.fn(() => "blob:picture");
  URL.revokeObjectURL = vi.fn();
});

function page(seed = true, screen: "feeds" | "settings" | "manage" = "feeds") {
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
      {screen === "feeds" ? (
        <RssView />
      ) : screen === "manage" ? (
        <FeedManagePage onClose={() => undefined} />
      ) : (
        <RssSettingsPage onClose={() => undefined} />
      )}
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
    // The articles' first pictures show beside them.
    await waitFor(() => expect(articles.querySelector('img[src="blob:picture"]')).toBeTruthy());
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

  it("keeps its settings, and reads the full text on opening when asked", async () => {
    const { feeds, runtime } = page(true, "settings");
    const stop = runtime.feeds.start();
    const keep = await screen.findByRole("radiogroup", { name: "文章保留" });
    expect(within(keep).getByRole("radio", { name: "90 天" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await userEvent.click(within(keep).getByRole("radio", { name: "30 天" }));
    expect(feeds.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ keepDays: 30 }));
    await userEvent.click(screen.getByRole("switch", { name: /打开文章时读取全文/ }));
    expect(feeds.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ keepDays: 30, autoFullText: true }),
    );
    await userEvent.click(screen.getByRole("switch", { name: /进入订阅时刷新/ }));
    expect(feeds.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshOnEnter: false }),
    );
    cleanup();
    // 订阅 itself now leaves entering alone and fetches 全文 as an article opens.
    render(
      <RuntimeContext.Provider value={runtime}>
        <RssView />
      </RuntimeContext.Provider>,
    );
    const list = await screen.findByRole("navigation", { name: "订阅列表" });
    await userEvent.click(within(list).getByRole("button", { name: /每日新闻/ }));
    const articles = await screen.findByRole("dialog", { name: "每日新闻" });
    await userEvent.click(await within(articles).findByText("每日新闻 · 第 1 篇"));
    const article = await screen.findByRole("article", { name: "每日新闻 · 第 1 篇" });
    expect(await within(article).findByText("（全文）")).toBeTruthy();
    expect(feeds.fetchFullText).toHaveBeenCalledTimes(1);
    expect(feeds.refresh).not.toHaveBeenCalled();
    stop();
  });

  it("goes back from an article to its list, then from the list", async () => {
    page();
    const list = await screen.findByRole("navigation", { name: "订阅列表" });
    await userEvent.click(within(list).getByRole("button", { name: /每日新闻/ }));
    const articles = await screen.findByRole("dialog", { name: "每日新闻" });
    await userEvent.click(await within(articles).findByText("每日新闻 · 第 1 篇"));
    await screen.findByRole("article", { name: "每日新闻 · 第 1 篇" });
    // Back (Escape, as the Android gesture arrives) closes the article only.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull());
    expect(screen.getByRole("dialog", { name: "每日新闻" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "每日新闻" })).toBeNull());
  });

  it("long-press menu marks below as read and keeps an article unread", async () => {
    const { feeds } = page();
    const list = await screen.findByRole("navigation", { name: "订阅列表" });
    await userEvent.click(within(list).getByRole("button", { name: /每日新闻/ }));
    const articles = await screen.findByRole("dialog", { name: "每日新闻" });
    const second = await within(articles).findByText("每日新闻 · 第 2 篇");
    fireEvent.contextMenu(second, { clientX: 120, clientY: 200 });
    const menu = await screen.findByRole("menu", { name: "文章菜单" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "以下标为已读" }));
    await waitFor(() =>
      expect(feeds.markReadRange).toHaveBeenCalledWith(
        expect.objectContaining({ feed: "https://news.example.com/feed" }),
        expect.objectContaining({ id: "https://news.example.com/feed#1" }),
        false,
      ),
    );
    const first = within(articles).getByText("每日新闻 · 第 1 篇");
    fireEvent.contextMenu(first, { clientX: 120, clientY: 120 });
    await userEvent.click(
      within(await screen.findByRole("menu", { name: "文章菜单" })).getByRole("menuitem", {
        name: "保持未读",
      }),
    );
    expect(feeds.setArticleState).toHaveBeenLastCalledWith(["https://news.example.com/feed#0"], {
      keepUnread: true,
    });
    expect(await within(articles).findByLabelText("保持未读")).toBeTruthy();
    // Opening it leaves it unread.
    await userEvent.click(first);
    await screen.findByRole("article", { name: "每日新闻 · 第 1 篇" });
    expect(feeds.setArticleState).not.toHaveBeenCalledWith(["https://news.example.com/feed#0"], {
      read: true,
    });
  });

  it("manages feeds: adds one, sets one's own settings, and arranges groups", async () => {
    const { feeds, runtime } = page(true, "manage");
    const stop = runtime.feeds.start();
    const manage = await screen.findByRole("dialog", { name: "管理订阅" });
    expect(within(manage).queryByText("订阅设置")).toBeNull();
    expect(within(manage).getByRole("button", { name: "添加订阅" })).toBeTruthy();
    await userEvent.click(
      await within(manage).findByRole("button", { name: "打开 技术周刊 的详情" }),
    );
    const detail = await screen.findByRole("dialog", { name: "订阅详情" });
    await userEvent.click(within(detail).getByRole("switch", { name: /启用更新/ }));
    expect(within(detail).queryByRole("radiogroup", { name: "刷新间隔" })).toBeNull();
    await userEvent.click(within(detail).getByRole("switch", { name: /启用更新/ }));
    const interval = within(detail).getByRole("radiogroup", { name: "刷新间隔" });
    await userEvent.click(within(interval).getByRole("radio", { name: "自定义" }));
    const ask = await screen.findByRole("dialog", { name: "自定义刷新间隔" });
    await userEvent.type(within(ask).getByLabelText("自定义刷新间隔"), "3");
    expect(within(ask).getByRole("alert").textContent).toContain("5–1440");
    await userEvent.type(within(ask).getByLabelText("自定义刷新间隔"), "5");
    await userEvent.click(within(ask).getByRole("button", { name: "保存" }));
    expect(
      within(interval).getByRole("radio", { name: "35 分钟" }).getAttribute("aria-checked"),
    ).toBe("true");
    const keep = within(detail).getByRole("radiogroup", { name: "最多保留" });
    await userEvent.click(within(keep).getByRole("radio", { name: "不限" }));
    await userEvent.click(within(detail).getByRole("button", { name: "无分组" }));
    const address = within(detail).getByDisplayValue("https://tech.example.com/feed");
    await userEvent.clear(address);
    await userEvent.type(address, "https://tech.example.com/rss");
    await userEvent.click(within(detail).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(feeds.updateFeed).toHaveBeenCalledWith({
        url: "https://tech.example.com/feed",
        title: "技术周刊",
        group: null,
        newUrl: "https://tech.example.com/rss",
        enabled: true,
        options: expect.objectContaining({ refreshMinutes: 35, keepArticles: 0 }),
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "订阅详情" })).toBeNull());

    await userEvent.click(within(manage).getByRole("button", { name: /分组管理/ }));
    const groups = await screen.findByRole("dialog", { name: "分组管理" });
    await userEvent.type(within(groups).getByLabelText("分组名称"), "生活");
    await userEvent.click(within(groups).getByRole("button", { name: "新建分组" }));
    await waitFor(() => expect(feeds.saveGroups).toHaveBeenLastCalledWith(["新闻", "生活"]));
    await userEvent.click(await within(groups).findByRole("button", { name: "上移 生活" }));
    await waitFor(() => expect(feeds.saveGroups).toHaveBeenLastCalledWith(["生活", "新闻"]));
    await userEvent.click(within(groups).getByRole("button", { name: /^新闻/ }));
    await userEvent.click(within(groups).getByRole("radio", { name: "订阅移到未分组" }));
    await userEvent.click(within(groups).getByRole("button", { name: "删除分组「新闻」？" }));
    await waitFor(() => expect(feeds.removeGroup).toHaveBeenCalledWith("新闻", false));
    stop();
  });

  it("takes a custom refresh interval and marking read on scrolling", async () => {
    const { feeds, runtime } = page(true, "settings");
    const stop = runtime.feeds.start();
    expect(screen.queryByText("显示订阅标签")).toBeNull();
    const interval = await screen.findByRole("radiogroup", { name: "自动刷新" });
    await userEvent.click(within(interval).getByRole("radio", { name: "自定义" }));
    const ask = await screen.findByRole("dialog", { name: "自定义刷新间隔" });
    await userEvent.clear(within(ask).getByLabelText("自定义刷新间隔"));
    await userEvent.type(within(ask).getByLabelText("自定义刷新间隔"), "15");
    await userEvent.click(within(ask).getByRole("button", { name: "保存" }));
    expect(feeds.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshMinutes: 15 }),
    );
    await userEvent.click(screen.getByRole("switch", { name: /划出屏幕时标为已读/ }));
    expect(feeds.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ markReadOnScroll: true }),
    );
    stop();
  });

  it("marks articles read as they scroll up out of the list", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const watched: { callback: IntersectionObserverCallback; rows: Element[] }[] = [];
    window.IntersectionObserver = class {
      rows: Element[] = [];
      constructor(callback: IntersectionObserverCallback) {
        watched.push({ callback, rows: this.rows });
      }
      observe(row: Element) {
        this.rows.push(row);
      }
      disconnect() {}
      unobserve() {}
    } as never;
    const { feeds, runtime } = page();
    await feeds.saveSettings({ ...(await feeds.getSettings()), markReadOnScroll: true });
    const stop = runtime.feeds.start();
    const list = await screen.findByRole("navigation", { name: "订阅列表" });
    await userEvent.click(within(list).getByRole("button", { name: /每日新闻/ }));
    await screen.findByText("每日新闻 · 第 1 篇");
    const scrolled = await vi.waitFor(() => {
      const found = [...watched]
        .reverse()
        .find((item) => item.rows.some((row) => row.matches("[data-article]")));
      if (!found) throw new Error("rows not watched yet");
      return found;
    });
    const [first, second] = scrolled.rows;
    const entry = (target: Element, bottom: number) =>
      ({
        target,
        isIntersecting: false,
        boundingClientRect: { bottom },
        rootBounds: { top: 100 },
      }) as unknown as IntersectionObserverEntry;
    // The first left the top; the second is below the bottom, not passed.
    scrolled.callback([entry(first, 90), entry(second, 900)], {} as IntersectionObserver);
    await vi.advanceTimersByTimeAsync(1100);
    expect(feeds.setArticleState).toHaveBeenCalledWith(["https://news.example.com/feed#0"], {
      read: true,
    });
    expect(feeds.setArticleState).toHaveBeenCalledTimes(1);
    stop();
    vi.useRealTimers();
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
  });
});

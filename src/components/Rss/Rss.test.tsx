// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { feedServiceMocks } from "../../test/rss";
import { FeedManagePage } from "./FeedManagePage";
import { RssSettingsPage } from "./RssSettingsPage";
import { ROW_ESTIMATE } from "./ArticleList";
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

  it("finds feeds by words or an address, previews one, and subscribes", async () => {
    const { feeds } = page(false);
    await userEvent.click((await screen.findAllByRole("button", { name: "添加订阅" }))[0]);
    const search = await screen.findByRole("dialog", { name: "添加订阅" });
    const box = within(search).getByLabelText("关键字或网址");
    // Words look in the directory.
    await userEvent.type(box, "天气{Enter}");
    expect(await within(search).findByText("天气 日报")).toBeTruthy();
    expect(within(search).getAllByText("Feedly")).toHaveLength(3);
    expect(feeds.search).toHaveBeenLastCalledWith("天气");
    // An address finds its page's feed and an RSSHub route for it.
    await userEvent.clear(box);
    await userEvent.type(box, "new.example/user/7{Enter}");
    expect(await within(search).findByText("RSSHub")).toBeTruthy();
    await userEvent.click(within(search).getByRole("button", { name: "预览 new.example 的订阅" }));
    const preview = await screen.findByRole("dialog", { name: "new.example" });
    // Its articles open in place, and nothing is kept.
    await userEvent.click(await within(preview).findByText("new.example · 第 1 篇"));
    const reading = await screen.findByRole("dialog", { name: "new.example · 第 1 篇" });
    expect(within(reading).getByText(/的正文/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "new.example · 第 1 篇" })).toBeNull(),
    );
    expect(await feeds.listFeeds()).toHaveLength(0);
    await userEvent.click(within(preview).getByRole("button", { name: "订阅" }));
    const subscribe = await screen.findByRole("dialog", { name: "订阅" });
    await userEvent.type(within(subscribe).getByLabelText("分组"), "新分组");
    await userEvent.click(within(subscribe).getByRole("button", { name: "订阅" }));
    await waitFor(() =>
      expect(feeds.addFeed).toHaveBeenCalledWith(
        "https://new.example/user/7/feed",
        "new.example",
        "新分组",
      ),
    );
    // Back on the results, it shows as subscribed.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "new.example" })).toBeNull());
    expect(await within(search).findByText(/已订阅/)).toBeTruthy();
  });

  it("makes, tests, and switches off filters", async () => {
    const { feeds, runtime } = page(true, "settings");
    const stop = runtime.feeds.start();
    await userEvent.click(await screen.findByRole("button", { name: /过滤规则/ }));
    const filters = await screen.findByRole("dialog", { name: "过滤规则" });
    expect(within(filters).getByText("还没有过滤规则")).toBeTruthy();
    await userEvent.click(within(filters).getAllByRole("button", { name: "添加规则" })[0]);
    const editor = await screen.findByRole("dialog", { name: "新建规则" });
    await userEvent.type(within(editor).getByLabelText("正则表达式"), "第 (1|2) 篇");
    await userEvent.click(within(editor).getByRole("radio", { name: "分组" }));
    await userEvent.selectOptions(within(editor).getByLabelText("选择分组"), "技术");
    await userEvent.click(within(editor).getByRole("button", { name: "测试" }));
    expect(await within(editor).findByText("最近 8 篇里有 2 篇会被过滤")).toBeTruthy();
    expect(within(editor).getByText("技术周刊 · 第 1 篇")).toBeTruthy();
    await userEvent.click(within(editor).getByRole("switch", { name: /同时删除已有的命中文章/ }));
    await userEvent.click(within(editor).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(feeds.saveFilter).toHaveBeenCalledWith(
        expect.objectContaining({ pattern: "第 (1|2) 篇", scope: "group", target: "技术" }),
        true,
      ),
    );
    expect(await within(filters).findByText("第 (1|2) 篇")).toBeTruthy();
    expect(within(filters).getByText(/分组：技术/)).toBeTruthy();
    const total = (await feeds.listFeeds()).find((feed) => feed.group === "技术")!.total;
    // The starred one of the two stays.
    expect(total).toBe(7);
    await userEvent.click(within(filters).getByRole("switch", { name: "启用规则 第 (1|2) 篇" }));
    await waitFor(() =>
      expect(feeds.saveFilter).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabled: false }),
        false,
      ),
    );
    // A bad expression says why.
    await userEvent.click(within(filters).getAllByRole("button", { name: "添加规则" })[0]);
    const bad = await screen.findByRole("dialog", { name: "新建规则" });
    await userEvent.type(within(bad).getByLabelText("正则表达式"), "(");
    await userEvent.click(within(bad).getByRole("button", { name: "测试" }));
    expect(await within(bad).findByRole("alert")).toBeTruthy();
    stop();
  });

  it("shows unread counts over 999 as 999+", async () => {
    const { feeds, runtime } = page();
    const list = await screen.findByRole("navigation", { name: "订阅列表" });
    const listed = await feeds.listFeeds();
    vi.mocked(feeds.listFeeds).mockResolvedValue(
      listed.map((feed, index) => (index === 0 ? { ...feed, unread: 12_345 } : feed)),
    );
    void runtime.feeds.loadFeeds();
    expect(await within(list).findAllByText("999+")).not.toHaveLength(0);
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
    // The scroll containers scroll here as they do in the app.
    const style = document.createElement("style");
    style.textContent = ".overflow-y-auto { overflow-y: auto; }";
    document.head.append(style);
    const { feeds, runtime } = page();
    await feeds.saveSettings({ ...(await feeds.getSettings()), markReadOnScroll: true });
    const stop = runtime.feeds.start();
    const list = await screen.findByRole("navigation", { name: "订阅列表" });
    await userEvent.click(within(list).getByRole("button", { name: /每日新闻/ }));
    const row = await screen.findByText("每日新闻 · 第 1 篇");
    const scroller = row.closest(".overflow-y-auto") as HTMLElement;
    // jsdom does not lay out or scroll: the position, and where the list
    // then sits, are set by hand.
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (value) => (top = value) });
    row.closest("ul")!.getBoundingClientRect = () => DOMRect.fromRect({ y: -top });
    // Three rows (estimated heights) and a little of the fourth are past.
    scroller.scrollTop = ROW_ESTIMATE * 3 + 10;
    fireEvent.scroll(scroller);
    await vi.waitFor(() =>
      expect(feeds.setArticleState).toHaveBeenCalledWith(
        [
          "https://news.example.com/feed#0",
          "https://news.example.com/feed#1",
          "https://news.example.com/feed#2",
        ],
        { read: true },
      ),
    );
    expect(feeds.setArticleState).toHaveBeenCalledTimes(1);
    // Scrolling back and down again marks nothing more.
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await vi.advanceTimersByTimeAsync(100);
    scroller.scrollTop = ROW_ESTIMATE * 3 + 10;
    fireEvent.scroll(scroller);
    await vi.advanceTimersByTimeAsync(1100);
    expect(feeds.setArticleState).toHaveBeenCalledTimes(1);
    stop();
    vi.useRealTimers();
    style.remove();
  });
});

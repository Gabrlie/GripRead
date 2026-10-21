import { describe, expect, it, vi } from "vitest";
import { feedServiceMocks } from "../test/rss";
import {
  ENTER_REFRESH_GAP_MS,
  FeedStore,
  REFRESH_SILENCE_MS,
  feedGroupNames,
  feedGroups,
  refreshScheduled,
  selectionTitle,
} from "./rss";

describe("订阅 store", () => {
  it("groups feeds in order with unread totals, ungrouped last", async () => {
    const feeds = await feedServiceMocks().listFeeds();
    const groups = feedGroups(feeds);
    expect(groups.map((group) => group.name)).toEqual(["新闻", "技术", null]);
    expect(groups[0].unread).toBe(feeds[0].unread);
  });

  it("filters, pages, and shows read and starred changes at once", async () => {
    const service = feedServiceMocks();
    const store = new FeedStore(service);
    await store.loadFeeds();
    await store.loadArticles();
    const all = store.getSnapshot().articles.length;
    expect(all).toBeGreaterThan(0);
    store.setFilter("unread");
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false));
    const unread = store.getSnapshot().articles;
    expect(unread.every((article) => !article.read)).toBe(true);
    const target = unread[0];
    const before = store.getSnapshot().feeds.find((feed) => feed.url === target.feedUrl)!.unread;
    const saving = store.setState([target.id], { read: true, starred: true });
    // Shown before the save finishes.
    expect(store.getSnapshot().articles[0]).toMatchObject({ read: true, starred: true });
    expect(store.getSnapshot().feeds.find((feed) => feed.url === target.feedUrl)!.unread).toBe(
      before - 1,
    );
    await saving;
    expect(service.setArticleState).toHaveBeenCalledWith([target.id], {
      read: true,
      starred: true,
    });
    store.setFilter("starred");
    await vi.waitFor(() =>
      expect(store.getSnapshot().articles.map((article) => article.id)).toContain(target.id),
    );
  });

  it("puts a change back when it cannot be saved", async () => {
    const service = feedServiceMocks(true, {
      setArticleState: vi.fn(async () => {
        throw new Error("磁盘已满");
      }),
    });
    const store = new FeedStore(service);
    await store.loadArticles();
    const first = store.getSnapshot().articles[0];
    await expect(store.setState([first.id], { starred: !first.starred })).rejects.toThrow();
    expect(store.getSnapshot().articles[0].starred).toBe(first.starred);
    expect(store.getSnapshot().error).toContain("磁盘已满");
  });

  it("refreshes once at a time, on entering when old, and on its interval", async () => {
    let now = 1_000_000_000;
    const service = feedServiceMocks();
    const store = new FeedStore(service, () => now);
    await store.loadFeeds();
    await Promise.all([store.refresh(), store.refresh()]);
    expect(service.refresh).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ refreshing: null, lastRefresh: now });
    await store.enter();
    expect(service.refresh).toHaveBeenCalledTimes(1);
    now += ENTER_REFRESH_GAP_MS;
    await store.enter();
    expect(service.refresh).toHaveBeenCalledTimes(2);
    // The interval asks the core for the feeds due; off, a feed's own still counts.
    const settings = await service.getSettings();
    const feeds = store.getSnapshot().feeds;
    expect(refreshScheduled(settings, feeds)).toBe(true);
    expect(refreshScheduled({ ...settings, refreshMinutes: 0 }, feeds)).toBe(false);
    const own = feeds.map((feed, index) =>
      index ? feed : { ...feed, options: { ...feed.options, refreshMinutes: 30 } },
    );
    expect(refreshScheduled({ ...settings, refreshMinutes: 0 }, own)).toBe(true);
    // Nothing due: no progress shown, and the last refresh stays.
    const last = store.getSnapshot().lastRefresh;
    now += 60_000;
    await store.refresh([], true);
    expect(service.refresh).toHaveBeenLastCalledWith(expect.any(String), [], true, []);
    expect(store.getSnapshot()).toMatchObject({ refreshing: null, lastRefresh: last });
  });

  it("leaves entering alone when refreshing on entering is off", async () => {
    const service = feedServiceMocks();
    await service.saveSettings({ ...(await service.getSettings()), refreshOnEnter: false });
    const store = new FeedStore(service, () => 1_000_000_000);
    // Entering before the settings have loaded still reads them first.
    await store.enter();
    expect(service.refresh).not.toHaveBeenCalled();
    expect(store.getSnapshot().settings?.refreshOnEnter).toBe(false);
  });

  it("puts the settings back when they cannot be saved", async () => {
    const service = feedServiceMocks(true, {
      saveSettings: vi.fn(async () => {
        throw new Error("磁盘已满");
      }),
    });
    const store = new FeedStore(service);
    const stop = store.start();
    await vi.waitFor(() => expect(store.getSnapshot().settings).not.toBeNull());
    const before = store.getSnapshot().settings!;
    await expect(store.saveSettings({ ...before, keepDays: 30 })).rejects.toThrow();
    expect(store.getSnapshot().settings).toEqual(before);
    stop();
  });

  it("marks the chosen list read and follows a removed feed back to all", async () => {
    const service = feedServiceMocks();
    const store = new FeedStore(service);
    await store.loadFeeds();
    const feed = store.getSnapshot().feeds[0];
    store.select({ kind: "feed", url: feed.url });
    await store.markAllRead();
    expect(service.markAllRead).toHaveBeenCalledWith({
      feed: feed.url,
      group: null,
      account: null,
    });
    expect(store.getSnapshot().feeds[0].unread).toBe(0);
    await store.removeFeeds([feed.url]);
    expect(store.getSnapshot().selection).toEqual({ kind: "all" });
  });

  it("keeps an account's feeds and groups to the account, and syncs it when added", async () => {
    const service = feedServiceMocks();
    const store = new FeedStore(service);
    await store.loadFeeds();
    const account = await store.saveAccount({
      id: null,
      kind: "freshRss",
      name: "",
      server: "https://rss.example",
      username: "me",
      password: "secret",
      filterRead: false,
    });
    expect(service.refresh).toHaveBeenLastCalledWith(expect.any(String), [], false, [account.id]);
    const state = store.getSnapshot();
    expect(state.accounts.map((item) => item.name)).toEqual(["me"]);
    // The device's groups stay its own; the account's come from its feeds.
    expect(feedGroupNames(state, null)).toEqual(["新闻", "技术"]);
    expect(feedGroupNames(state, account.id)).toEqual(["资讯"]);
    store.select({ kind: "group", group: "资讯", account: account.id });
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false));
    const listed = store.getSnapshot().articles;
    expect(listed.length).toBe(10);
    expect(listed.every((article) => article.feedUrl.startsWith(`account:${account.id}:`))).toBe(
      true,
    );
    expect(
      selectionTitle({ kind: "account", account: account.id }, state.feeds, state.accounts),
    ).toBe("me");
    store.select({ kind: "account", account: account.id });
    await store.markAllRead();
    expect(service.markAllRead).toHaveBeenLastCalledWith({
      feed: null,
      group: null,
      account: account.id,
    });
    await store.removeAccount(account.id);
    expect(store.getSnapshot()).toMatchObject({ selection: { kind: "all" }, accounts: [] });
    expect(store.getSnapshot().feeds.every((feed) => feed.account === null)).toBe(true);
  });

  it("shows how far an account's sync has fetched, and lets a silent refresh go", async () => {
    const service = feedServiceMocks();
    const store = new FeedStore(service);
    let listener: Parameters<typeof service.onRefresh>[0] = () => undefined;
    vi.mocked(service.onRefresh).mockImplementation(async (heard) => {
      listener = heard;
      return () => undefined;
    });
    let finish: () => void = () => undefined;
    vi.mocked(service.refresh).mockImplementation(
      (operationId) =>
        new Promise<void>((resolve) => {
          listener({
            operationId,
            url: "account:a",
            refreshed: 0,
            total: 2,
            newArticles: 0,
            error: null,
            step: { done: 400, total: 1000 },
            done: false,
          });
          finish = resolve;
        }),
    );
    vi.useFakeTimers();
    try {
      const run = store.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getSnapshot().refreshing).toEqual({
        done: 0,
        total: 2,
        step: { account: "a", done: 400, total: 1000 },
      });
      // Nothing heard for long: the refresh is let go, and another may start.
      await vi.advanceTimersByTimeAsync(REFRESH_SILENCE_MS);
      await run;
      expect(store.getSnapshot()).toMatchObject({ refreshing: null });
      expect(store.getSnapshot().error).toContain("刷新很久没有进展");
      void store.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.refresh).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      vi.useRealTimers();
    }
  });
});

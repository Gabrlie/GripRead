import { describe, expect, it, vi } from "vitest";
import { feedServiceMocks } from "../test/rss";
import { ENTER_REFRESH_GAP_MS, FeedStore, feedGroups, refreshDue } from "./rss";

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
    const settings = await service.getSettings();
    expect(refreshDue(settings, now, now + 59 * 60_000)).toBe(false);
    expect(refreshDue(settings, now, now + 60 * 60_000)).toBe(true);
    expect(refreshDue({ ...settings, refreshMinutes: 0 }, 0, now)).toBe(false);
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
    expect(service.markAllRead).toHaveBeenCalledWith({ feed: feed.url, group: null });
    expect(store.getSnapshot().feeds[0].unread).toBe(0);
    await store.removeFeeds([feed.url]);
    expect(store.getSnapshot().selection).toEqual({ kind: "all" });
  });
});

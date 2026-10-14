import type { FeedService } from "../services/contracts";
import type {
  ArticleCursor,
  ArticleFilter,
  ArticleQuery,
  ArticleSummary,
  Feed,
  OpmlImportReport,
  RssSettings,
} from "../types/generated";

/** What the article list shows: everything, one group, or one feed. */
export type FeedSelection =
  { kind: "all" } | { kind: "group"; group: string } | { kind: "feed"; url: string };

export interface FeedGroup {
  /** `null` for feeds without a group. */
  name: string | null;
  feeds: Feed[];
  unread: number;
}

export interface FeedSnapshot {
  feeds: Feed[];
  feedsLoaded: boolean;
  selection: FeedSelection;
  filter: ArticleFilter;
  search: string;
  articles: ArticleSummary[];
  next: ArticleCursor | null;
  /** The first page is loading (later loads keep the list). */
  loading: boolean;
  loadingMore: boolean;
  refreshing: { done: number; total: number } | null;
  /** When the last refresh finished. */
  lastRefresh: number;
  /** Feeds that failed in the last refresh. */
  failed: number;
  error: string | null;
  settings: RssSettings | null;
}

/** Entering 订阅 refreshes when the last refresh is older than this. */
export const ENTER_REFRESH_GAP_MS = 10 * 60_000;
/** How often the interval refresh checks whether it is due. */
const SCHEDULE_TICK_MS = 60_000;
const PAGE = 50;

/** The groups in the order their first feed appears, ungrouped feeds last. */
export function feedGroups(feeds: Feed[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  const loose: Feed[] = [];
  for (const feed of feeds) {
    if (feed.group === null) {
      loose.push(feed);
      continue;
    }
    let group = groups.find((item) => item.name === feed.group);
    if (!group) {
      group = { name: feed.group, feeds: [], unread: 0 };
      groups.push(group);
    }
    group.feeds.push(feed);
    group.unread += feed.unread;
  }
  if (loose.length)
    groups.push({
      name: null,
      feeds: loose,
      unread: loose.reduce((sum, feed) => sum + feed.unread, 0),
    });
  return groups;
}

export function selectionTitle(selection: FeedSelection, feeds: Feed[]): string {
  if (selection.kind === "all") return "全部文章";
  if (selection.kind === "group") return selection.group;
  return feeds.find((feed) => feed.url === selection.url)?.title ?? "订阅";
}

/** Whether a refresh is due by the interval setting. */
export function refreshDue(settings: RssSettings | null, lastRefresh: number, now: number) {
  if (!settings || settings.refreshMinutes <= 0) return false;
  return now - lastRefresh >= settings.refreshMinutes * 60_000;
}

/**
 * 订阅's state: the feeds, the chosen list and its pages of articles,
 * read and starred changes shown at once and saved behind, and refreshing
 * (on entering, on pulling down, and on the interval while the app is
 * visible).
 */
export class FeedStore {
  private snapshot: FeedSnapshot = {
    feeds: [],
    feedsLoaded: false,
    selection: { kind: "all" },
    filter: "all",
    search: "",
    articles: [],
    next: null,
    loading: true,
    loadingMore: false,
    refreshing: null,
    lastRefresh: 0,
    failed: 0,
    error: null,
    settings: null,
  };
  private listeners = new Set<() => void>();
  private listVersion = 0;
  private refreshRun: Promise<void> | null = null;
  constructor(
    private service: FeedService,
    private now: () => number = Date.now,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<FeedSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** Loads the feeds and settings and starts the interval refresh. */
  start = () => {
    let stopped = false;
    void this.loadFeeds();
    void this.service.getSettings().then(
      (settings) => !stopped && this.update({ settings }),
      () => undefined,
    );
    const timer = setInterval(() => {
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      if (visible && refreshDue(this.snapshot.settings, this.snapshot.lastRefresh, this.now()))
        void this.refresh();
    }, SCHEDULE_TICK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  };

  /** Entering 订阅: the list, and a refresh when the last one is old. */
  enter = async () => {
    if (!this.snapshot.articles.length) await this.loadArticles();
    if (this.now() - this.snapshot.lastRefresh >= ENTER_REFRESH_GAP_MS) await this.refresh();
  };

  loadFeeds = async () => {
    try {
      const feeds = await this.service.listFeeds();
      this.update({ feeds, feedsLoaded: true });
    } catch (error) {
      this.update({ feedsLoaded: true, error: String(error) });
    }
  };

  private query(after: ArticleCursor | null): ArticleQuery {
    const { selection, filter, search } = this.snapshot;
    return {
      feed: selection.kind === "feed" ? selection.url : null,
      group: selection.kind === "group" ? selection.group : null,
      filter,
      search: search.trim() || null,
      after,
      limit: PAGE,
    };
  }

  /** The first page of the chosen list; `quiet` keeps the list while it loads. */
  loadArticles = async (quiet = false) => {
    const version = ++this.listVersion;
    if (!quiet) this.update({ loading: true, error: null });
    try {
      const page = await this.service.listArticles(this.query(null));
      if (version !== this.listVersion) return;
      this.update({ articles: page.articles, next: page.next, loading: false });
    } catch (error) {
      if (version === this.listVersion) this.update({ loading: false, error: String(error) });
    }
  };

  loadMore = async () => {
    const { next, loadingMore } = this.snapshot;
    if (!next || loadingMore) return;
    const version = this.listVersion;
    this.update({ loadingMore: true });
    try {
      const page = await this.service.listArticles(this.query(next));
      if (version !== this.listVersion) return;
      const known = new Set(this.snapshot.articles.map((article) => article.id));
      this.update({
        articles: [
          ...this.snapshot.articles,
          ...page.articles.filter((article) => !known.has(article.id)),
        ],
        next: page.next,
        loadingMore: false,
      });
    } catch (error) {
      this.update({ loadingMore: false, error: String(error) });
    }
  };

  select = (selection: FeedSelection) => {
    this.update({ selection, articles: [], next: null });
    void this.loadArticles();
  };
  setFilter = (filter: ArticleFilter) => {
    if (filter === this.snapshot.filter) return;
    this.update({ filter, articles: [], next: null });
    void this.loadArticles();
  };
  setSearch = (search: string) => {
    this.update({ search });
    void this.loadArticles(true);
  };

  /** Refreshes feeds (all when none are named); one refresh runs at a time. */
  refresh = (urls: string[] = []): Promise<void> => {
    if (this.refreshRun) return this.refreshRun;
    const operationId = `rss-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let failed = 0;
    this.update({ refreshing: { done: 0, total: urls.length || this.snapshot.feeds.length } });
    const run = (async () => {
      const stop = await this.service
        .onRefresh((event) => {
          if (event.operationId !== operationId || event.done) return;
          if (event.error) failed++;
          this.update({ refreshing: { done: event.refreshed, total: event.total } });
        })
        .catch(() => () => undefined);
      try {
        await this.service.refresh(operationId, urls);
      } catch (error) {
        this.update({ error: String(error) });
      } finally {
        stop();
      }
      this.update({ refreshing: null, lastRefresh: this.now(), failed });
      await Promise.all([this.loadFeeds(), this.loadArticles(true)]);
    })();
    this.refreshRun = run.finally(() => {
      this.refreshRun = null;
    });
    return this.refreshRun;
  };

  /** Read and starred changes show at once; a failed save puts them back. */
  setState = async (ids: string[], state: { read?: boolean; starred?: boolean }) => {
    const before = this.snapshot.articles;
    const beforeFeeds = this.snapshot.feeds;
    const changed = new Set(ids);
    const unreadDelta = new Map<string, number>();
    const articles = before.map((article) => {
      if (!changed.has(article.id)) return article;
      if (state.read !== undefined && state.read !== article.read)
        unreadDelta.set(
          article.feedUrl,
          (unreadDelta.get(article.feedUrl) ?? 0) + (state.read ? -1 : 1),
        );
      return {
        ...article,
        read: state.read ?? article.read,
        starred: state.starred ?? article.starred,
      };
    });
    this.update({
      articles,
      feeds: beforeFeeds.map((feed) =>
        unreadDelta.has(feed.url)
          ? { ...feed, unread: Math.max(0, feed.unread + unreadDelta.get(feed.url)!) }
          : feed,
      ),
    });
    try {
      await this.service.setArticleState(ids, state);
    } catch (error) {
      this.update({ articles: before, feeds: beforeFeeds, error: String(error) });
      throw error;
    }
  };

  /** 全部标为已读 for the chosen list. */
  markAllRead = async () => {
    const { selection } = this.snapshot;
    const changed = await this.service.markAllRead({
      feed: selection.kind === "feed" ? selection.url : null,
      group: selection.kind === "group" ? selection.group : null,
    });
    await Promise.all([this.loadFeeds(), this.loadArticles(true)]);
    return changed;
  };

  addFeed = async (url: string, title: string | null, group: string | null) => {
    const feed = await this.service.addFeed(url, title, group);
    await Promise.all([this.loadFeeds(), this.loadArticles(true)]);
    return feed;
  };

  updateFeed = async (url: string, title: string, group: string | null) => {
    await this.service.updateFeed(url, title, group);
    await this.loadFeeds();
  };

  removeFeeds = async (urls: string[]) => {
    await this.service.removeFeeds(urls);
    const { selection } = this.snapshot;
    if (selection.kind === "feed" && urls.includes(selection.url))
      this.update({ selection: { kind: "all" } });
    await Promise.all([this.loadFeeds(), this.loadArticles(true)]);
  };

  importOpml = async (): Promise<OpmlImportReport | null> => {
    const report = await this.service.importOpml();
    if (report?.added) {
      await this.loadFeeds();
      void this.refresh();
    }
    return report;
  };

  exportOpml = () => this.service.exportOpml();

  saveSettings = async (settings: RssSettings) => {
    this.update({ settings });
    this.update({ settings: await this.service.saveSettings(settings) });
  };
}

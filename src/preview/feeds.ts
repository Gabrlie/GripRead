import type { FeedService } from "../services/contracts";
import type {
  Article,
  ArticleSummary,
  Feed,
  RssRefreshEvent,
  RssSettings,
} from "../types/generated";

interface Stored {
  summary: ArticleSummary;
  content: string;
}

const HOUR = 3_600_000;

function sampleArticles(feed: Feed, count: number, now: number): Stored[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${feed.url}#${index}`;
    const title = `${feed.title} · 第 ${index + 1} 篇`;
    return {
      summary: {
        id,
        feedUrl: feed.url,
        feedTitle: feed.title,
        title,
        link: `${feed.siteUrl ?? "https://example.com"}/posts/${index + 1}`,
        author: index % 2 ? "编辑部" : null,
        publishedAt: now - index * 5 * HOUR - feed.sort * HOUR,
        excerpt: "这是一段文章摘要，用来在列表中预览文章的开头内容。",
        image: null,
        read: index > 2,
        starred: index === 1,
      },
      content: `<p>${title}的正文。</p><p>第二段文字，带一个<a href="https://example.com">链接</a>。</p><blockquote>引用的一段话。</blockquote>`,
    };
  });
}

/**
 * Subscriptions kept in memory: the preview build's 订阅, and the base of
 * the test doubles. `seed` adds sample feeds and articles.
 */
export function memoryFeeds(seed = true): FeedService {
  const now = Date.now();
  let feeds: Feed[] = [];
  let articles: Stored[] = [];
  let settings: RssSettings = { refreshMinutes: 60, markReadOnOpen: true, fontSize: 17 };
  const listeners = new Set<(event: RssRefreshEvent) => void>();
  const feed = (url: string, title: string, group: string | null, sort: number): Feed => ({
    url,
    title,
    siteUrl: url.replace(/\/feed.*$/, ""),
    iconUrl: null,
    group,
    sort,
    addedAt: now - sort,
    lastFetch: now,
    lastError: null,
    unread: 0,
    total: 0,
  });
  if (seed) {
    feeds = [
      feed("https://news.example.com/feed", "每日新闻", "新闻", 0),
      feed("https://tech.example.com/feed", "技术周刊", "技术", 1),
      feed("https://blog.example.com/feed", "个人博客", null, 2),
    ];
    articles = feeds.flatMap((item, index) => sampleArticles(item, 6 + index * 2, now));
  }
  const counted = (): Feed[] =>
    feeds.map((item) => {
      const own = articles.filter((article) => article.summary.feedUrl === item.url);
      return {
        ...item,
        total: own.length,
        unread: own.filter((article) => !article.summary.read).length,
      };
    });
  const find = (id: string) => {
    const found = articles.find((article) => article.summary.id === id);
    if (!found) throw new Error("没有这篇文章");
    return found;
  };
  return {
    listFeeds: async () => counted(),
    discover: async (url) => [{ url, title: new URL(url).hostname }],
    addFeed: async (url, title, group) => {
      if (feeds.some((item) => item.url === url)) throw new Error("已经订阅过这个地址");
      const added = feed(url, title || new URL(url).hostname, group, feeds.length);
      feeds = [...feeds, added];
      articles = [...articles, ...sampleArticles(added, 3, Date.now())];
      return counted().find((item) => item.url === url)!;
    },
    updateFeed: async (url, title, group) => {
      feeds = feeds.map((item) => (item.url === url ? { ...item, title, group } : item));
    },
    removeFeeds: async (urls) => {
      feeds = feeds.filter((item) => !urls.includes(item.url));
      articles = articles.filter(
        (article) => !urls.includes(article.summary.feedUrl) || article.summary.starred,
      );
    },
    refresh: async (operationId, urls) => {
      const targets = urls.length ? urls : feeds.map((item) => item.url);
      targets.forEach((url, index) =>
        listeners.forEach((listener) =>
          listener({
            operationId,
            url,
            refreshed: index + 1,
            total: targets.length,
            newArticles: 0,
            error: null,
            done: false,
          }),
        ),
      );
      listeners.forEach((listener) =>
        listener({
          operationId,
          url: "",
          refreshed: targets.length,
          total: targets.length,
          newArticles: 0,
          error: null,
          done: true,
        }),
      );
    },
    onRefresh: async (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listArticles: async (query) => {
      const group = query.group ?? null;
      const search = query.search?.trim().toLowerCase() ?? "";
      const known = new Set(feeds.map((item) => item.url));
      let list = articles
        .map((article) => article.summary)
        .filter((article) =>
          query.feed
            ? article.feedUrl === query.feed
            : group !== null
              ? feeds.find((item) => item.url === article.feedUrl)?.group === group
              : query.filter === "starred" || known.has(article.feedUrl),
        )
        .filter((article) =>
          query.filter === "unread"
            ? !article.read
            : query.filter === "starred"
              ? article.starred
              : true,
        )
        .filter(
          (article) =>
            !search ||
            article.title.toLowerCase().includes(search) ||
            article.excerpt.toLowerCase().includes(search),
        )
        .sort(
          (left, right) => right.publishedAt - left.publishedAt || right.id.localeCompare(left.id),
        );
      const after = query.after;
      if (after)
        list = list.filter(
          (article) =>
            article.publishedAt < after.publishedAt ||
            (article.publishedAt === after.publishedAt && article.id < after.id),
        );
      const limit = query.limit ?? 50;
      const page = list.slice(0, limit);
      const last = page.at(-1);
      return {
        articles: page,
        next: list.length > limit && last ? { publishedAt: last.publishedAt, id: last.id } : null,
      };
    },
    getArticle: async (id): Promise<Article> => {
      const found = find(id);
      return { summary: found.summary, content: found.content, fullText: null };
    },
    fetchFullText: async (id) => `${find(id).content}<p>（全文）</p>`,
    setArticleState: async (ids, state) => {
      articles = articles.map((article) =>
        ids.includes(article.summary.id)
          ? {
              ...article,
              summary: {
                ...article.summary,
                read: state.read ?? article.summary.read,
                starred: state.starred ?? article.summary.starred,
              },
            }
          : article,
      );
    },
    markAllRead: async (scope) => {
      let changed = 0;
      articles = articles.map((article) => {
        const owner = feeds.find((item) => item.url === article.summary.feedUrl);
        const inScope = scope.feed
          ? article.summary.feedUrl === scope.feed
          : scope.group
            ? owner?.group === scope.group
            : true;
        if (!inScope || article.summary.read) return article;
        changed++;
        return { ...article, summary: { ...article.summary, read: true } };
      });
      return changed;
    },
    image: async () => new ArrayBuffer(0),
    importOpml: async () => ({ added: 0, existing: 0 }),
    exportOpml: async () => false,
    getSettings: async () => settings,
    saveSettings: async (next) => (settings = next),
  };
}

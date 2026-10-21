import type { FeedService } from "../services/contracts";
import type {
  Article,
  ArticleQuery,
  ArticleSummary,
  Feed,
  FeedAccount,
  FeedFilter,
  FeedGroup,
  FeedSearchResult,
  RssRefreshEvent,
  RssSettings,
} from "../types/generated";

interface Stored {
  summary: ArticleSummary;
  content: string;
}

const HOUR = 3_600_000;

/** A picture for sample articles: a tinted square, as the cache would give. */
function samplePicture(url: string): ArrayBuffer {
  const hue = [...url].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="hsl(${hue} 45% 62%)"/><circle cx="112" cy="48" r="18" fill="hsl(${hue} 60% 85%)"/><path d="M0 160 L58 86 L96 128 L122 104 L160 140 V160 Z" fill="hsl(${hue} 40% 40%)"/></svg>`;
  return new TextEncoder().encode(svg).buffer as ArrayBuffer;
}

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
        image: index % 3 === 0 ? `${feed.url}/picture/${index}.svg` : null,
        read: index > 2,
        starred: index === 1,
        keepUnread: false,
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
  let groups: FeedGroup[] = [];
  let settings: RssSettings = {
    refreshMinutes: 60,
    markReadOnOpen: true,
    fontSize: 17,
    refreshOnEnter: true,
    autoFullText: false,
    listImages: true,
    keepDays: 90,
    keepArticles: 500,
    markReadOnScroll: false,
    keepUnreadArticles: false,
    imageCacheMb: 500,
    rsshubInstance: "https://rsshub.app",
    rsshubKey: "",
  };
  let filters: FeedFilter[] = [];
  let accounts: FeedAccount[] = [];
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
    enabled: true,
    options: {
      refreshMinutes: null,
      keepArticles: null,
      keepDays: null,
      fullText: null,
      viaServer: false,
      keepUnread: null,
    },
    newest: null,
    account: null,
    address: null,
  });
  /** A feed of an account, as its service names it. */
  const accountFeed = (
    account: string,
    stream: number,
    title: string,
    group: string | null,
  ): Feed => ({
    ...feed(`account:${account}:feed/${stream}`, title, group, stream),
    siteUrl: `https://remote${stream}.example.org`,
    account,
    address: `https://remote${stream}.example.org/feed`,
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
        newest: own.reduce<number | null>(
          (newest, article) => Math.max(newest ?? 0, article.summary.publishedAt),
          null,
        ),
      };
    });
  /** The groups in order: those arranged, then those only feeds name. */
  const allGroups = (): FeedGroup[] => {
    const list = [...groups];
    for (const item of feeds)
      if (
        item.account === null &&
        item.group !== null &&
        !list.some((group) => group.name === item.group)
      )
        list.push({ name: item.group, sort: list.length });
    return list;
  };
  /** The list's articles, newest first, as the core filters them. */
  const listed = (query: ArticleQuery) => {
    const group = query.group ?? null;
    const search = query.search?.trim().toLowerCase() ?? "";
    const known = new Set(feeds.map((item) => item.url));
    return articles
      .map((article) => article.summary)
      .filter((article) => {
        const owner = feeds.find((item) => item.url === article.feedUrl);
        if (query.feed) return article.feedUrl === query.feed;
        if (group !== null)
          return owner?.group === group && owner.account === (query.account ?? null);
        if (query.account) return owner?.account === query.account;
        return query.filter === "starred" || known.has(article.feedUrl);
      })
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
  };
  const markRead = (ids: Set<string>) => {
    let changed = 0;
    articles = articles.map((article) => {
      if (!ids.has(article.summary.id) || article.summary.read || article.summary.keepUnread)
        return article;
      changed++;
      return { ...article, summary: { ...article.summary, read: true } };
    });
    return changed;
  };
  /** The stored articles a rule applies to, newest first, and those it keeps out. */
  const filtered = (rule: FeedFilter) => {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.pattern, rule.ignoreCase ? "i" : "");
    } catch {
      throw new Error("正则表达式有误");
    }
    const applies = (article: ArticleSummary) =>
      rule.scope === "all" ||
      (rule.scope === "feed"
        ? article.feedUrl === rule.target
        : feeds.some(
            (item) =>
              item.url === article.feedUrl && item.account === null && item.group === rule.target,
          ));
    const text = (article: Stored) => {
      const { title, author } = article.summary;
      const body = article.content.replace(/<[^>]*>/g, " ");
      if (rule.field === "title") return title;
      if (rule.field === "author") return author ?? "";
      if (rule.field === "content") return body;
      return `${title}\n${author ?? ""}\n${body}`;
    };
    const checked = articles
      .filter((article) => applies(article.summary))
      .sort((left, right) => right.summary.publishedAt - left.summary.publishedAt);
    const out = checked.filter((article) => pattern.test(text(article)) === (rule.mode === "drop"));
    return { checked, out };
  };
  const find = (id: string) => {
    const found = articles.find((article) => article.summary.id === id);
    if (!found) throw new Error("没有这篇文章");
    return found;
  };
  return {
    listFeeds: async () => counted(),
    search: async (query): Promise<FeedSearchResult[]> => {
      const text = query.trim();
      if (!text) return [];
      if (!/^\S+\.\S+$/.test(text) && !text.includes("://"))
        return ["日报", "周刊", "博客"].map((kind, index) => ({
          url: `https://${index + 1}.example.org/feed`,
          title: `${text} ${kind}`,
          site: `https://${index + 1}.example.org`,
          description: `关于「${text}」的${kind}，每天更新。`,
          subscribers: 1200 >> index,
          icon: null,
          source: "feedly",
        }));
      const url = text.includes("://") ? text : `https://${text}`;
      const { hostname, pathname } = new URL(url);
      const results: FeedSearchResult[] = [];
      if (/feed|rss|atom|\.xml/.test(pathname))
        results.push({
          url,
          title: hostname,
          site: null,
          description: null,
          subscribers: null,
          icon: null,
          source: "feed",
        });
      else
        results.push(
          {
            url: `${url.replace(/\/$/, "")}/feed`,
            title: `${hostname} 的订阅`,
            site: url,
            description: null,
            subscribers: null,
            icon: null,
            source: "page",
          },
          {
            url: `${settings.rsshubInstance}/example${pathname}`,
            title: `${hostname} · 动态`,
            site: url,
            description: `/example${pathname}`,
            subscribers: null,
            icon: null,
            source: "rsshub",
          },
        );
      return results;
    },
    preview: async (url) => {
      const title = new URL(url).hostname;
      const sample = feed(url, title, null, 0);
      return {
        url,
        title,
        siteUrl: sample.siteUrl,
        articles: sampleArticles(sample, 8, Date.now()).map(({ summary, content }) => ({
          id: summary.id,
          title: summary.title,
          link: summary.link,
          author: summary.author,
          publishedAt: summary.publishedAt,
          excerpt: summary.excerpt,
          image: summary.image,
          content,
        })),
      };
    },
    addFeed: async (url, title, group, account = null) => {
      if (feeds.some((item) => item.url === url || item.address === url))
        throw new Error("已经订阅过这个地址");
      const name = title || new URL(url).hostname;
      const added = account
        ? { ...accountFeed(account, feeds.length + 10, name, group), address: url }
        : feed(url, name, group, feeds.length);
      feeds = [...feeds, added];
      articles = [...articles, ...sampleArticles(added, 3, Date.now())];
      return counted().find((item) => item.url === added.url)!;
    },
    updateFeed: async (request) => {
      const url = request.newUrl?.trim() || request.url;
      if (url !== request.url && feeds.some((item) => item.url === url))
        throw new Error("已经订阅过这个地址");
      feeds = feeds.map((item) =>
        item.url === request.url
          ? {
              ...item,
              url,
              title: request.title,
              group: request.group,
              enabled: request.enabled ?? item.enabled,
              options: request.options ?? item.options,
            }
          : item,
      );
      if (url !== request.url)
        articles = articles.map((article) =>
          article.summary.feedUrl === request.url
            ? { ...article, summary: { ...article.summary, feedUrl: url } }
            : article,
        );
      return counted().find((item) => item.url === url)!;
    },
    listGroups: async () => allGroups(),
    saveGroups: async (names) => {
      const rest = allGroups().filter((group) => !names.includes(group.name));
      groups = [...names.map((name) => ({ name, sort: 0 })), ...rest].map((group, sort) => ({
        name: group.name,
        sort,
      }));
    },
    renameGroup: async (name, newName, account = null) => {
      if (account !== null) {
        feeds = feeds.map((item) =>
          item.account === account && item.group === name ? { ...item, group: newName } : item,
        );
        return;
      }
      const merging = allGroups().some((group) => group.name === newName);
      groups = allGroups()
        .filter((group) => !(merging && group.name === name))
        .map((group) => (group.name === name ? { ...group, name: newName } : group));
      feeds = feeds.map((item) =>
        item.account === null && item.group === name ? { ...item, group: newName } : item,
      );
    },
    removeGroup: async (name, unsubscribe, account = null) => {
      if (account === null) groups = allGroups().filter((group) => group.name !== name);
      const urls = feeds
        .filter((item) => item.account === account && item.group === name)
        .map((item) => item.url);
      if (unsubscribe) {
        feeds = feeds.filter((item) => !urls.includes(item.url));
        articles = articles.filter(
          (article) => !urls.includes(article.summary.feedUrl) || article.summary.starred,
        );
      } else
        feeds = feeds.map((item) => (urls.includes(item.url) ? { ...item, group: null } : item));
    },
    removeFeeds: async (urls) => {
      feeds = feeds.filter((item) => !urls.includes(item.url));
      articles = articles.filter(
        (article) => !urls.includes(article.summary.feedUrl) || article.summary.starred,
      );
    },
    refresh: async (operationId, urls, due = false, named = []) => {
      const enabled = feeds
        .filter((item) => item.enabled && item.account === null)
        .map((item) => item.url);
      const everything = !urls.length && !named.length;
      const synced = accounts
        .map((account) => account.id)
        .filter(
          (id) =>
            everything ||
            named.includes(id) ||
            urls.some((url) => url.startsWith(`account:${id}:`)),
        )
        .map((id) => `account:${id}`);
      const targets = due
        ? []
        : [...synced, ...(everything ? enabled : urls.filter((url) => enabled.includes(url)))];
      accounts = accounts.map((account) =>
        synced.includes(`account:${account.id}`) ? { ...account, lastSync: Date.now() } : account,
      );
      targets.forEach((url, index) => {
        // An account fetches its articles along the way.
        if (url.startsWith("account:"))
          for (const done of [0, 100, 200])
            listeners.forEach((listener) =>
              listener({
                operationId,
                url,
                refreshed: index,
                total: targets.length,
                newArticles: 0,
                error: null,
                step: { done, total: 200 },
                done: false,
              }),
            );
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
        );
      });
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
      let list = listed(query);
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
                read: state.keepUnread ? false : (state.read ?? article.summary.read),
                starred: state.starred ?? article.summary.starred,
                keepUnread: state.keepUnread ?? (state.read ? false : article.summary.keepUnread),
              },
            }
          : article,
      );
    },
    markAllRead: async (scope) =>
      markRead(
        new Set(
          articles
            .filter((article) => {
              const owner = feeds.find((item) => item.url === article.summary.feedUrl);
              if (scope.feed) return article.summary.feedUrl === scope.feed;
              if (scope.group)
                return owner?.group === scope.group && owner.account === (scope.account ?? null);
              return scope.account ? owner?.account === scope.account : true;
            })
            .map((article) => article.summary.id),
        ),
      ),
    markReadRange: async (query, from, newer) => {
      const list = listed({ ...query, after: null });
      const at = list.findIndex((article) => article.id === from.id);
      if (at < 0) return 0;
      const range = newer ? list.slice(0, at + 1) : list.slice(at);
      return markRead(new Set(range.map((article) => article.id)));
    },
    image: async (url) => (url.endsWith(".svg") ? samplePicture(url) : new ArrayBuffer(0)),
    importOpml: async () => ({ added: 0, existing: 0 }),
    exportOpml: async () => false,
    getSettings: async () => settings,
    saveSettings: async (next) => (settings = next),
    listFilters: async () => filters,
    saveFilter: async (rule, purge) => {
      const { out } = filtered(rule);
      const saved = rule.id
        ? rule
        : { ...rule, id: `filter-${Date.now()}-${filters.length}`, sort: filters.length };
      filters = filters.some((item) => item.id === saved.id)
        ? filters.map((item) => (item.id === saved.id ? saved : item))
        : [...filters, saved];
      if (purge) {
        const gone = new Set(
          out.filter((article) => !article.summary.starred).map((article) => article.summary.id),
        );
        articles = articles.filter((article) => !gone.has(article.summary.id));
      }
      return saved;
    },
    removeFilter: async (id) => {
      filters = filters.filter((item) => item.id !== id);
    },
    listAccounts: async () => accounts,
    saveAccount: async (request) => {
      if (request.password === "wrong")
        throw new Error("用户名或密码不对（FreshRSS 和 Miniflux 用的是 API 密码）");
      const id = request.id ?? `${request.username}-${accounts.length + 1}`;
      const saved: FeedAccount = {
        id,
        kind: request.kind,
        name: request.name.trim() || request.username,
        server: request.server,
        username: request.username,
        filterRead: request.filterRead,
        sort: accounts.length,
        lastSync: request.id ? (accounts.find((item) => item.id === id)?.lastSync ?? null) : null,
        lastError: null,
        pending: 0,
      };
      if (request.id) {
        accounts = accounts.map((item) => (item.id === id ? saved : item));
        return saved;
      }
      accounts = [...accounts, saved];
      const remote = [
        accountFeed(id, 1, "远方新闻", "资讯"),
        accountFeed(id, 2, "远方杂志", "资讯"),
        accountFeed(id, 3, "远方博客", null),
      ];
      feeds = [...feeds, ...remote];
      articles = [...articles, ...remote.flatMap((item) => sampleArticles(item, 5, Date.now()))];
      return saved;
    },
    removeAccount: async (id) => {
      accounts = accounts.filter((item) => item.id !== id);
      const urls = new Set(feeds.filter((item) => item.account === id).map((item) => item.url));
      feeds = feeds.filter((item) => !urls.has(item.url));
      articles = articles.filter((article) => !urls.has(article.summary.feedUrl));
    },
    testFilter: async (rule) => {
      const { checked, out } = filtered(rule);
      return {
        checked: Math.min(checked.length, 2000),
        dropped: out.length,
        samples: out.slice(0, 5).map((article) => article.summary.title),
      };
    },
  };
}

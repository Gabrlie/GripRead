import type { SourceService } from "../services/contracts";
import type {
  SourceSubscription,
  BookSourceSummary,
  OnlineBook,
  OnlineChapter,
  OnlineSearchEvent,
  SourceCheckEvent,
  SourceDebugEvent,
  SourceImportItem,
  OnlineTocEvent,
  DownloadJob,
  LibraryBook,
} from "../types/generated";

type Raw = Record<string, unknown>;

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function summaryOf(raw: Raw): BookSourceSummary {
  return {
    url: text(raw.bookSourceUrl),
    name: text(raw.bookSourceName),
    group: text(raw.bookSourceGroup),
    enabled: raw.enabled !== false,
    enabledExplore: raw.enabledExplore !== false,
    hasExplore: Boolean(text(raw.exploreUrl).trim()),
    hasSearch: Boolean(text(raw.searchUrl).trim()),
    hasLogin: Boolean(text(raw.loginUrl).trim() || text(raw.loginUi).trim()),
    customOrder: Number(raw.customOrder ?? 0),
    weight: Number(raw.weight ?? 0),
    lastUpdateTime: Number(raw.lastUpdateTime ?? 0),
    respondTime: Number(raw.respondTime ?? 180000),
    comment: text(raw.bookSourceComment),
    viaServer: raw.__viaServer === true,
  };
}

function parse(json: string): Raw[] {
  const value: unknown = JSON.parse(json);
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is Raw => typeof item === "object" && item !== null);
}

/** A simplified stand-in for the engine's merge: same name and author fold together. */
function mergeSearchResults(key: string, books: OnlineBook[], precise: boolean) {
  const results: OnlineSearchEvent["results"] = [];
  for (const book of books) {
    if (precise && !book.name.includes(key) && !book.author.includes(key)) continue;
    const same = results.find((item) => item.name === book.name && item.author === book.author);
    if (same) same.origins.push(book);
    else results.push({ ...book, origins: [book] });
  }
  return results.sort((a, b) => b.origins.length - a.origins.length);
}

function groups(group: string): string[] {
  return group
    .split(/[,;，；]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Sources kept in memory with the engine's management behavior, for the
 * preview build and component tests. Debugging and checks report scripted
 * steps instead of fetching.
 */
export function createMemorySourceService(
  initial: Raw[] = [],
  catalogue: OnlineBook[] = [],
): SourceService {
  let sources: Raw[] = initial.map((raw) => ({ ...raw }));
  let subscriptions: SourceSubscription[] = [];
  const searchListeners = new Set<(event: OnlineSearchEvent) => void>();
  const cancelled = new Set<string>();
  const debugListeners = new Set<(event: SourceDebugEvent) => void>();
  const checkListeners = new Set<(event: SourceCheckEvent) => void>();
  const tocListeners = new Set<(event: OnlineTocEvent) => void>();
  const downloadListeners = new Set<(jobs: DownloadJob[]) => void>();
  const downloads: DownloadJob[] = [];
  const kept = new Map<string, LibraryBook>();
  const keptChapters = new Map<string, OnlineChapter[]>();
  const find = (url: string) => sources.find((raw) => raw.bookSourceUrl === url);
  const ordered = () =>
    [...sources].sort(
      (a, b) =>
        Number(a.customOrder ?? 0) - Number(b.customOrder ?? 0) ||
        text(a.bookSourceName).localeCompare(text(b.bookSourceName)),
    );
  const update = async (urls: string[], change: (raw: Raw) => void) => {
    for (const url of urls) {
      const raw = find(url);
      if (raw) change(raw);
    }
  };
  return {
    listSources: async () => ordered().map(summaryOf),
    getSource: async (url) => {
      const raw = find(url);
      if (!raw) throw new Error(`没有这个书源：${url}`);
      return { summary: summaryOf(raw), json: JSON.stringify(raw, null, 2) };
    },
    previewImport: async (json) => {
      const items: SourceImportItem[] = [];
      const invalid: string[] = [];
      let skipped = 0;
      for (const raw of parse(json)) {
        if (Number(raw.bookSourceType ?? 0) !== 0) {
          skipped += 1;
          continue;
        }
        if (!text(raw.bookSourceUrl) || !text(raw.bookSourceName)) {
          invalid.push("书源缺少 bookSourceUrl 或名称");
          continue;
        }
        const local = find(text(raw.bookSourceUrl));
        items.push({
          url: text(raw.bookSourceUrl),
          name: text(raw.bookSourceName),
          group: text(raw.bookSourceGroup),
          status: !local
            ? "new"
            : Number(raw.lastUpdateTime ?? 0) > Number(local.lastUpdateTime ?? 0)
              ? "update"
              : "existing",
        });
      }
      return { items, skipped, invalid };
    },
    importSources: async (request) => {
      const saved: BookSourceSummary[] = [];
      for (const raw of parse(request.json)) {
        const url = text(raw.bookSourceUrl);
        if (!request.urls.includes(url)) continue;
        const local = find(url);
        const next = { ...raw };
        if (local) {
          if (request.keepName) next.bookSourceName = local.bookSourceName;
          if (request.keepGroup) next.bookSourceGroup = local.bookSourceGroup;
          if (request.keepEnabled) {
            next.enabled = local.enabled;
            next.enabledExplore = local.enabledExplore;
          }
          next.customOrder = local.customOrder;
        }
        sources = [...sources.filter((item) => item.bookSourceUrl !== url), next];
        saved.push(summaryOf(next));
      }
      return saved;
    },
    fetchText: async () => {
      throw new Error("预览模式不能联网导入");
    },
    pickSourceFile: async () => null,
    saveSource: async (json, previousUrl) => {
      const [raw] = parse(json);
      if (!raw || !text(raw.bookSourceUrl) || !text(raw.bookSourceName))
        throw new Error("书源需要地址和名称");
      const url = text(raw.bookSourceUrl);
      sources = sources.filter(
        (item) => item.bookSourceUrl !== url && item.bookSourceUrl !== previousUrl,
      );
      sources.push({ ...raw, lastUpdateTime: Date.now() });
      return summaryOf(raw);
    },
    deleteSources: async (urls) => {
      sources = sources.filter((raw) => !urls.includes(text(raw.bookSourceUrl)));
    },
    setSwitch: (urls, which, on) =>
      update(urls, (raw) => {
        raw[which === "enabled" ? "enabled" : "enabledExplore"] = on;
      }),
    changeGroup: (urls, group, add) =>
      update(urls, (raw) => {
        let list = groups(text(raw.bookSourceGroup));
        for (const name of groups(group)) {
          list = add
            ? list.includes(name)
              ? list
              : [...list, name]
            : list.filter((item) => item !== name);
        }
        raw.bookSourceGroup = list.join(",");
      }),
    moveSources: async (urls, top) => {
      const orders = sources.map((raw) => Number(raw.customOrder ?? 0));
      let next = top ? Math.min(0, ...orders) - urls.length : Math.max(0, ...orders) + 1;
      for (const url of urls) {
        const raw = find(url);
        if (raw) raw.customOrder = next++;
      }
    },
    exportSources: async (urls) =>
      JSON.stringify(
        ordered().filter((raw) => !urls.length || urls.includes(text(raw.bookSourceUrl))),
        null,
        2,
      ),
    exportSourcesFile: async () => false,
    getLoginForm: async (url) => {
      const raw = find(url);
      let rows: { name: string; type?: string; action?: string }[] = [];
      try {
        rows = JSON.parse(text(raw?.loginUi) || "[]") as typeof rows;
      } catch {
        rows = [];
      }
      return {
        rows: rows.map((row) => ({
          name: row.name,
          kind: row.type ?? "text",
          action: row.action ?? null,
          defaultValue: null,
          chars: [],
        })),
        values: {},
        browserOnly: !rows.length && /^https?:/.test(text(raw?.loginUrl)),
        loginUrl: text(raw?.loginUrl) || null,
        lastLogin: null,
        lastLoginAt: null,
      };
    },
    login: async () => ({ result: "已登录", logs: [], loggedIn: true }),
    getVariable: async (url) => text(find(url)?.__variable) || null,
    setVariable: (url, value) =>
      update([url], (raw) => {
        raw.__variable = value ?? "";
      }),
    clearCookies: async () => undefined,
    setViaServer: (urls, on) =>
      update(urls, (raw) => {
        raw.__viaServer = on;
      }),
    debug: async (request) => {
      const lines = [
        `︽ 搜索「${request.key}」`,
        "搜索到 1 本书",
        "︽ 详情",
        "︽ 目录",
        "共 3 章",
        "︽ 正文",
      ];
      lines.forEach((line, index) =>
        setTimeout(() => {
          for (const listener of debugListeners)
            listener({ operationId: request.operationId, line, done: false, error: null });
          if (index === lines.length - 1)
            for (const listener of debugListeners)
              listener({
                operationId: request.operationId,
                line: "✓ 调试完成",
                done: true,
                error: null,
              });
        }, index * 120),
      );
    },
    onNotice: async () => () => undefined,
    listSubscriptions: async () => subscriptions.map((item) => ({ ...item })),
    saveSubscription: async (subscription) => {
      const url = subscription.url.trim();
      const found = subscriptions.find(
        (item) => (subscription.id && item.id === subscription.id) || item.url === url,
      );
      const name = subscription.name.trim() || new URL(url).host;
      if (found) Object.assign(found, { name, url });
      else
        subscriptions.push({
          id: subscription.id || `sub-${subscriptions.length + 1}`,
          name,
          url,
          updatedAt: null,
          imported: null,
        });
      return subscriptions.map((item) => ({ ...item }));
    },
    deleteSubscription: async (id) => {
      subscriptions = subscriptions.filter((item) => item.id !== id);
      return subscriptions.map((item) => ({ ...item }));
    },
    subscriptionImported: async (id, count) => {
      const found = subscriptions.find((item) => item.id === id);
      if (found) Object.assign(found, { updatedAt: Date.now(), imported: count });
      return subscriptions.map((item) => ({ ...item }));
    },
    onDebug: async (listener) => {
      debugListeners.add(listener);
      return () => debugListeners.delete(listener);
    },
    check: async (request) => {
      const total = request.urls.length;
      request.urls.forEach((url, index) =>
        setTimeout(() => {
          const raw = find(url);
          for (const listener of checkListeners)
            listener({
              operationId: request.operationId,
              url,
              name: text(raw?.bookSourceName),
              message: "校验成功（120 ms）",
              finished: true,
              ok: true,
              checked: index + 1,
              total,
            });
          if (index === total - 1)
            for (const listener of checkListeners)
              listener({
                operationId: request.operationId,
                url: "",
                name: "",
                message: "校验完成",
                finished: true,
                ok: true,
                checked: total,
                total,
              });
        }, index * 150),
      );
    },
    onCheck: async (listener) => {
      checkListeners.add(listener);
      return () => checkListeners.delete(listener);
    },
    cancel: async (operationId) => {
      cancelled.add(operationId);
      return { requested: true };
    },
    search: async (request) => {
      const asked = sources.filter((raw) =>
        request.scope.sourceUrls.length
          ? request.scope.sourceUrls.includes(text(raw.bookSourceUrl))
          : raw.enabled !== false &&
            Boolean(text(raw.searchUrl)) &&
            (!request.scope.groups.length ||
              groups(text(raw.bookSourceGroup)).some((name) =>
                request.scope.groups.includes(name),
              )),
      );
      const found: OnlineBook[] = [];
      const emit = (searched: number, done: boolean) => {
        for (const listener of searchListeners)
          listener({
            operationId: request.operationId,
            searched,
            total: asked.length,
            done,
            results: mergeSearchResults(request.key, found, request.precise),
            failures: [],
          });
      };
      if (!asked.length) {
        setTimeout(() => emit(0, true));
        return;
      }
      asked.forEach((raw, index) =>
        setTimeout(
          () => {
            if (cancelled.has(request.operationId)) return;
            found.push(
              ...catalogue.filter(
                (book) =>
                  book.sourceUrl === raw.bookSourceUrl &&
                  (book.name.includes(request.key) || book.author.includes(request.key)),
              ),
            );
            emit(index + 1, index === asked.length - 1);
          },
          (index + 1) * 150,
        ),
      );
    },
    onSearch: async (listener) => {
      searchListeners.add(listener);
      return () => searchListeners.delete(listener);
    },
    exploreKinds: async (sourceUrl) =>
      text(find(sourceUrl)?.exploreUrl)
        .split(/&&|\n/)
        .filter((part) => part.trim())
        .map((part) => {
          const [title, url] = part.split("::");
          return { title: title.trim(), url: url?.trim() || null, style: null };
        }),
    exploreBooks: async (sourceUrl, _url, page) =>
      page > 2 ? [] : catalogue.filter((book) => book.sourceUrl === sourceUrl),
    bookInfo: async (book) => ({
      ...book,
      intro: book.intro || "这是一本用于预览的网络书籍。",
      tocUrl: book.tocUrl || `${book.bookUrl}/toc`,
    }),
    chapters: async (book) =>
      Array.from({ length: 24 }, (_, index): OnlineChapter => ({
        index,
        title: index === 0 ? "正文卷" : `第${index}章 ${book.name}的第${index}章`,
        url: index === 0 ? "正文卷0" : `${book.bookUrl}/${index}.html`,
        baseUrl: book.bookUrl,
        isVolume: index === 0,
        isVip: index > 20,
        isPay: false,
        tag: "",
        variables: "",
      })),
    chapterContent: async (book, chapter) => ({
      title: null,
      text: Array.from(
        { length: 12 },
        (_, index) => `《${book.name}》${chapter.title}的第 ${index + 1} 段预览正文。`,
      ).join("\n"),
    }),
    cover: async () => {
      throw new Error("预览模式不加载封面");
    },
    setCoverFromSource: async () => undefined,
    dataUsage: async () => ({
      parts: [
        { key: "unshelved", label: "未加入书架的网络书籍", bytes: 1_800_000, clearable: true },
        { key: "shelved", label: "书架书籍的章节缓存", bytes: 3_200_000, clearable: true },
        { key: "covers", label: "封面缓存", bytes: 860_000, clearable: true },
        { key: "requests", label: "书源详情与目录缓存", bytes: 240_000, clearable: true },
        { key: "logs", label: "日志", bytes: 24_000, clearable: true },
        { key: "books", label: "本地书籍", bytes: 12_400_000, clearable: false },
        { key: "database", label: "数据库", bytes: 2_100_000, clearable: false },
      ],
      books: [...kept.values()]
        .filter((entry) => entry.online?.onShelf)
        .map((entry) => ({
          bookId: entry.book.id,
          title: entry.book.title,
          bytes: 400_000,
          cachedChapters: entry.online?.cachedChapters ?? 0,
          totalChapters: entry.online?.totalChapters ?? 0,
        })),
    }),
    clearData: async () => undefined,
    convertToLocal: async (bookId) => {
      const entry = kept.get(bookId);
      if (!entry) throw new Error("书籍不存在");
      kept.delete(bookId);
      return { ...entry, online: null };
    },
    addOnlineBook: async ({ book, chapters, onShelf }) => {
      const existing = [...kept.values()].find(
        (entry) =>
          entry.online?.book.sourceUrl === book.sourceUrl &&
          entry.online.book.bookUrl === book.bookUrl,
      );
      const id = existing?.book.id ?? `online-${kept.size + 1}`;
      const entry: LibraryBook = {
        book: {
          id,
          title: book.name,
          author: book.author || null,
          contentVersion: "online",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        asset: null,
        online: {
          book,
          totalChapters: chapters.length,
          newChapters: 0,
          lastCheckTime: null,
          updateError: null,
          canUpdate: true,
          onShelf: onShelf || Boolean(existing?.online?.onShelf),
          readChapter: null,
          readChapterTitle: "",
          cachedChapters: 0,
        },
        locator: null,
        totalLength: null,
        txtEncoding: null,
        lastReadAt: null,
        removedAt: null,
        shelfState: null,
        coverAssetId: null,
        useReplaceRules: true,
        inCloud: false,
      };
      kept.set(id, entry);
      keptChapters.set(id, chapters);
      return entry;
    },
    changeSource: async ({ bookId, book, chapters }) => {
      const entry = kept.get(bookId);
      if (!entry?.online) throw new Error("书籍不存在");
      const changed: LibraryBook = {
        ...entry,
        online: { ...entry.online, book, totalChapters: chapters.length, cachedChapters: 0 },
      };
      kept.set(bookId, changed);
      keptChapters.set(bookId, chapters);
      return { book: changed, chapter: entry.online.readChapter, certain: true, locator: null };
    },
    findOnlineBook: async (name, author) => {
      const same = [...kept.values()].filter(
        (entry) => entry.book.title === name && (entry.book.author ?? "") === author,
      );
      return same.find((entry) => entry.online?.onShelf) ?? same[0] ?? null;
    },
    getLibraryBook: async (bookId) => {
      const entry = kept.get(bookId);
      if (!entry) throw new Error("书籍不存在");
      return entry;
    },
    setOnShelf: async (bookId, on) => {
      const entry = kept.get(bookId);
      if (entry?.online) kept.set(bookId, { ...entry, online: { ...entry.online, onShelf: on } });
    },
    setCanUpdate: async (bookId, on) => {
      const entry = kept.get(bookId);
      if (entry?.online) kept.set(bookId, { ...entry, online: { ...entry.online, canUpdate: on } });
    },
    leaveOnlineBook: async (bookId) => {
      const entry = kept.get(bookId);
      if (!entry?.online || entry.online.onShelf) return false;
      kept.delete(bookId);
      return true;
    },
    listOnlineChapters: async (bookId) => keptChapters.get(bookId) ?? [],
    clearOnlineCache: async () => undefined,
    updateToc: async (request) => {
      for (const listener of tocListeners)
        listener({
          operationId: request.operationId,
          bookId: "",
          updated: 0,
          total: 0,
          newChapters: 0,
          error: null,
          done: true,
        });
    },
    onTocUpdate: async (listener) => {
      tocListeners.add(listener);
      return () => tocListeners.delete(listener);
    },
    enqueueDownload: async (bookId, start, end) => {
      const entry = kept.get(bookId);
      const job: DownloadJob = {
        id: `download-${downloads.length + 1}`,
        bookId,
        title: entry?.book.title ?? bookId,
        start,
        end,
        state: "done",
        cached: end - start,
        failed: 0,
        total: end - start,
        createdAt: Date.now(),
      };
      downloads.push(job);
      for (const listener of downloadListeners) listener([...downloads]);
      return job;
    },
    listDownloads: async () => [...downloads],
    pauseDownload: async () => undefined,
    resumeDownload: async () => undefined,
    cancelDownload: async () => undefined,
    pauseAllDownloads: async () => undefined,
    clearFinishedDownloads: async () => {
      downloads.splice(0, downloads.length);
      for (const listener of downloadListeners) listener([]);
    },
    onDownloads: async (listener) => {
      downloadListeners.add(listener);
      return () => downloadListeners.delete(listener);
    },
    onDownloadStop: async () => () => undefined,
  };
}

/** Books the preview sources "find", for the search and explore pages. */
export const PREVIEW_BOOKS: OnlineBook[] = [
  ["https://www.example-a.com", "甲站小说", "剑来", "烽火戏诸侯", "玄幻,连载"],
  ["https://api.example-b.com", "乙站 API", "剑来", "烽火戏诸侯", "仙侠"],
  ["https://www.example-a.com", "甲站小说", "剑来外传", "某人", "同人"],
  ["https://api.example-b.com", "乙站 API", "雪中悍刀行", "烽火戏诸侯", "武侠,完结"],
].map(([sourceUrl, sourceName, name, author, kind]) => ({
  sourceUrl,
  sourceName,
  name,
  author,
  kind,
  coverUrl: "",
  intro: `${name}的简介。`,
  wordCount: "123.4万字",
  latestChapterTitle: "第一千章 终",
  bookUrl: `${sourceUrl}/book/${encodeURIComponent(name)}`,
  tocUrl: "",
  variables: "",
  reverseToc: false,
}));

/** A few sources to show the management pages in the preview build. */
export const PREVIEW_SOURCES: Raw[] = [
  {
    bookSourceUrl: "https://www.example-a.com",
    bookSourceName: "甲站小说",
    bookSourceGroup: "常用,精品",
    searchUrl: "/search?q={{key}}",
    exploreUrl: "玄幻::/sort/1_{{page}}.html&&都市::/sort/2_{{page}}.html",
    customOrder: 0,
    lastUpdateTime: 1700000000000,
    respondTime: 820,
  },
  {
    bookSourceUrl: "https://api.example-b.com",
    bookSourceName: "乙站 API",
    bookSourceGroup: "API",
    searchUrl: '/api/search,{"method":"POST"}',
    loginUrl: "function login() { java.log('login') }",
    loginUi: '[{"name":"账号","type":"text"},{"name":"密码","type":"password"}]',
    customOrder: 1,
    lastUpdateTime: 1700000000000,
    respondTime: 1500,
  },
  {
    bookSourceUrl: "https://www.example-c.net",
    bookSourceName: "丙站（失效）",
    bookSourceGroup: "网站失效",
    bookSourceComment: "// Error: 网络请求失败",
    searchUrl: "/s.php",
    enabled: false,
    customOrder: 2,
    lastUpdateTime: 1690000000000,
    respondTime: 181200,
  },
];

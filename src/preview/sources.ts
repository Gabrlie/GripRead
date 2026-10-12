import type { SourceService } from "../services/contracts";
import type {
  BookSourceSummary,
  SourceCheckEvent,
  SourceDebugEvent,
  SourceImportItem,
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
  };
}

function parse(json: string): Raw[] {
  const value: unknown = JSON.parse(json);
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is Raw => typeof item === "object" && item !== null);
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
export function createMemorySourceService(initial: Raw[] = []): SourceService {
  let sources: Raw[] = initial.map((raw) => ({ ...raw }));
  const debugListeners = new Set<(event: SourceDebugEvent) => void>();
  const checkListeners = new Set<(event: SourceCheckEvent) => void>();
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
      };
    },
    login: async () => ({ result: "已登录", logs: [] }),
    getVariable: async (url) => text(find(url)?.__variable) || null,
    setVariable: (url, value) =>
      update([url], (raw) => {
        raw.__variable = value ?? "";
      }),
    clearCookies: async () => undefined,
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
    cancel: async () => ({ requested: true }),
  };
}

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

/**
 * In-memory services for `vite --mode preview`: the real UI runs in a plain
 * browser with a sample novel, so layouts can be inspected and captured
 * without Tauri. Production builds never import this module.
 */
import type { AppServices } from "../services/contracts";
import type {
  Bookmark,
  BookTocSettings,
  ContentWindow,
  LibraryBook,
  ReaderLocator,
  ReaderPreferences,
  ShelfPreferences,
  ShelfState,
  ReplaceRule,
  TocEntry,
  TxtTocRule,
} from "../types/generated";
import { DEFAULT_READING_STYLE } from "../types/generated";
import { createMemorySourceService, PREVIEW_BOOKS, PREVIEW_SOURCES } from "./sources";
import { PREVIEW_NETWORK } from "./network";
import type { CloudBook, RemoteBackup, WebDavSettings } from "../types/generated";

const BOOK_ID = "preview-book";
const VERSION = "preview-v1";
const RESOURCE = "preview-asset";

function sampleText(): { text: string; toc: Omit<TocEntry, "ordinal" | "length">[] } {
  const paragraph = (seed: number) =>
    "　　" +
    [
      "山门前的石阶覆着一层薄霜，少年背着竹篓一步步向上走去。",
      "云海在脚下翻涌，远处的钟声一下一下敲在心上。",
      "他想起离家时母亲的叮嘱，攥紧了手中那枚温润的玉佩。",
      "风从松林间穿过，带来草木和雨水的气味。",
      "石碑上的字迹早已斑驳，却仍能辨出“问道”二字。",
    ]
      .slice(seed % 3, (seed % 3) + 3)
      .join("");
  let text = "《云海问道》是一部关于少年求道、山河远行的长篇小说。\n本书仅用于界面预览。\n\n";
  const toc: Omit<TocEntry, "ordinal" | "length">[] = [];
  const locator = (offset: number): ReaderLocator => ({
    bookId: BOOK_ID,
    contentVersion: VERSION,
    resourceId: RESOURCE,
    offset,
    contextBefore: "",
    contextAfter: "",
  });
  let chapter = 1;
  for (const volume of ["第一卷 山门", "第二卷 远行"]) {
    toc.push({ title: volume, volume: true, locator: locator(text.length) });
    text += `${volume}\n`;
    for (let index = 0; index < 12; index += 1) {
      const title = `第${chapter}章 ${["初入山门", "石阶问心", "夜雨听松", "云海惊涛"][chapter % 4]}`;
      toc.push({ title, volume: false, locator: locator(text.length) });
      text += `${title}\n`;
      for (let line = 0; line < 14; line += 1) text += `${paragraph(chapter + line)}\n`;
      chapter += 1;
    }
  }
  return { text, toc };
}

const { text: TEXT, toc: TOC } = sampleText();

function contextFor(offset: number): ReaderLocator {
  return {
    bookId: BOOK_ID,
    contentVersion: VERSION,
    resourceId: RESOURCE,
    offset,
    contextBefore: TEXT.slice(Math.max(0, offset - 32), offset),
    contextAfter: TEXT.slice(offset, offset + 32),
  };
}

const ENTRIES: TocEntry[] = TOC.map((entry, index) => ({
  ...entry,
  ordinal: index,
  length: (TOC[index + 1]?.locator.offset ?? TEXT.length) - entry.locator.offset,
  locator: contextFor(entry.locator.offset),
}));

const RULES: TxtTocRule[] = [
  ["legado-1", "目录(去空白)", true],
  ["legado-2", "目录", true],
  ["legado-8", "数字 分隔符 标题名称", true],
  ["legado-12", "Chapter/Section/Part/Episode 序号 标题", true],
  ["legado-17", "章/卷 序号 标题", true],
  ["legado-18", "顶格标题", false],
].map(([id, name, enabled], serial) => ({
  id: id as string,
  name: name as string,
  pattern: "^第.+章.*$",
  example: "第一章 示例标题",
  serial,
  enabled: enabled as boolean,
  builtin: true,
}));

const PREFERENCES: ReaderPreferences = {
  theme: "system",
  paperTone: "warm-tea",
  oledBlack: false,
  fontSize: 19,
  lineHeight: 1.8,
  fontFamily: "serif",
  pageTurnEffect: "curl",
  autoPageSeconds: 8,
  readingMode: "single",
  autoScrollSpeed: 40,
  style: DEFAULT_READING_STYLE,
};

export function previewServices(): AppServices {
  let preferences = { ...PREFERENCES };
  let webdav: WebDavSettings = {
    url: "",
    username: "reader@example.com",
    password: "secret",
    folder: "",
    deviceName: "",
    localFolder: null,
    syncProgress: true,
    syncProgressPlus: false,
    restoreIgnore: [],
    configured: true,
    autoBackup: true,
    lastBackupAt: Date.now() - 3_600_000,
    lastError: null,
  };
  let backups: RemoteBackup[] = [
    {
      name: "auto-20261011-080000.json",
      size: 18_204,
      modified: Date.now() - 3_600_000,
      automatic: true,
      device: "Pixel 8",
    },
    {
      name: "manual-20261009-213000.json",
      size: 17_980,
      modified: Date.now() - 2 * 86_400_000,
      automatic: false,
      device: "书房平板",
    },
  ];
  let cloud: CloudBook[] = [
    {
      name: "云海问道.txt",
      title: "云海问道",
      author: null,
      size: 52_000,
      sourceSha256: "preview",
      uploadedAt: Date.now() - 86_400_000,
      localBookId: "preview-book",
      localRemoved: false,
    },
    {
      name: "山河故人.txt",
      title: "山河故人",
      author: "佚名",
      size: 1_204_000,
      sourceSha256: "other",
      uploadedAt: Date.now() - 3 * 86_400_000,
      localBookId: null,
      localRemoved: false,
    },
  ];
  let shelf: ShelfPreferences = { layout: "list", sort: "recent_read", groupId: "all" };
  let network = PREVIEW_NETWORK;
  let position: ReaderLocator | null = contextFor(ENTRIES[3].locator.offset);
  let settings: BookTocSettings = { ruleId: null, splitLongChapters: false };
  let shelfState: ShelfState | null = null;
  let readingSeconds = 1260;
  let replaceRules: ReplaceRule[] = [
    {
      id: "rule-ad",
      name: "去除广告",
      group: "净化",
      pattern: "^.*(请收藏|最新章节).*$",
      replacement: "",
      isRegex: true,
      scope: "",
      enabled: true,
      serial: 1,
    },
  ];
  const bookmarks: Bookmark[] = [
    {
      id: "mark-1",
      bookId: BOOK_ID,
      contentVersion: VERSION,
      locator: contextFor(ENTRIES[5].locator.offset + 40),
      excerpt: "云海在脚下翻涌，远处的钟声一下一下敲在心上。",
      note: "",
      createdAt: Date.now(),
    },
  ];
  const book = (): LibraryBook => ({
    book: {
      id: BOOK_ID,
      title: "云海问道",
      author: "预览作者",
      contentVersion: VERSION,
      createdAt: 1,
      updatedAt: 1,
    },
    asset: {
      id: RESOURCE,
      bookId: BOOK_ID,
      kind: "txt",
      sha256: "preview",
      byteLength: TEXT.length * 3,
      contentVersion: VERSION,
      availability: "ready",
      createdAt: 1,
    },
    locator: position,
    totalLength: TEXT.length,
    txtEncoding: { detected: "utf8", selected: "auto", state: "clean", canChange: true },
    lastReadAt: Date.now(),
    removedAt: null,
    shelfState,
    coverAssetId: null,
    useReplaceRules: true,
    inCloud: false,
    online: null,
  });
  const window = (start: number, end: number): ContentWindow => ({
    bookId: BOOK_ID,
    resourceId: RESOURCE,
    contentVersion: VERSION,
    text: TEXT.slice(start, end),
    startOffset: start,
    endOffset: end,
    totalLength: TEXT.length,
    hasBefore: start > 0,
    hasAfter: end < TEXT.length,
    locator: contextFor(start),
  });
  const unsupported = () => Promise.reject(new Error("预览模式不支持此操作"));
  return {
    library: {
      pickAndImportTxt: async () => null,
      startImport: unsupported,
      getImportStatus: unsupported,
      cancelImport: async () => ({ requested: false }),
      listBooks: async () => [book()],
      listRemovedBooks: async () => [],
      updateBook: unsupported,
      removeBook: unsupported,
      deleteBook: unsupported,
      restoreBook: unsupported,
      listGroups: async () => [],
      createGroup: unsupported,
      renameGroup: unsupported,
      deleteGroup: unsupported,
      moveBook: async (_bookId, placement) => {
        shelfState = placement.kind === "state" ? placement.value : null;
      },
      pickTxtFiles: async () => [],
      pickTxtFolder: async () => [],
      pickBookCover: async () => false,
      clearBookCover: async () => undefined,
      readAsset: unsupported,
      addReadingTime: async (_bookId, _day, seconds) => {
        readingSeconds += seconds;
      },
      ensureTextTransforms: async () => null,
      setBookReplaceRules: async () => undefined,
      deleteReadingRecord: async () => undefined,
      readingStats: async (today) => ({
        totalSeconds: readingSeconds + 5400,
        todaySeconds: readingSeconds,
        days: [
          { day: today, seconds: readingSeconds },
          { day: "2026-10-09", seconds: 3600 },
          { day: "2026-10-08", seconds: 1800 },
        ],
        books: [
          {
            bookId: BOOK_ID,
            seconds: readingSeconds + 5400,
            lastDay: today,
            title: book().book.title,
            author: book().book.author,
            deleted: false,
            lastReadAt: Date.now(),
          },
          {
            bookId: "retired:preview",
            seconds: 2400,
            lastDay: "2026-09-30",
            title: "已经删除的一本书",
            author: null,
            deleted: true,
            lastReadAt: null,
          },
        ],
      }),
      onImportProgress: async () => () => undefined,
      getTxtEncoding: async () => book().txtEncoding!,
      pickAndReassociateTxt: async () => null,
      reassociateTxtSource: unsupported,
      startTxtDecode: unsupported,
      getTxtDecodeStatus: unsupported,
      cancelTxtDecode: async () => ({ requested: false }),
      onTxtDecodeProgress: async () => () => undefined,
      getBookInfo: async () => ({
        bookId: BOOK_ID,
        intro: "《云海问道》是一部关于少年求道、山河远行的长篇小说。",
        sourceByteLength: TEXT.length * 3,
        chapterCount: ENTRIES.length,
        readingSeconds: readingSeconds + 5400,
      }),
    },
    reader: {
      readContentWindow: async (request) => {
        const anchor =
          request.locator?.offset ?? (request.direction === "forward" ? 0 : TEXT.length);
        return request.direction === "forward"
          ? window(anchor, Math.min(TEXT.length, anchor + request.maxUnits))
          : window(Math.max(0, anchor - request.maxUnits), anchor);
      },
      resolveLocator: async (_bookId, progress) =>
        contextFor(Math.round(Math.min(1, Math.max(0, progress)) * TEXT.length)),
      resolveOffset: async (request) => contextFor(Math.min(TEXT.length, request.offset)),
      saveReaderLocator: async (locator) => (position = locator),
      getSavedReaderLocator: async () => position,
      listToc: async () => ({
        entries: ENTRIES,
        ruleId: settings.ruleId ?? "legado-1",
        ruleName: RULES.find((rule) => rule.id === (settings.ruleId ?? "legado-1"))!.name,
        settings,
      }),
      listTxtTocRules: async () => RULES,
      saveTxtTocRule: async (rule) => rule,
      deleteTxtTocRule: async () => undefined,
      orderTxtTocRules: async () => RULES,
      importTxtTocRules: async () => [],
      exportTxtTocRules: async () => JSON.stringify(RULES),
      testTxtTocRule: async (_pattern, sample) => sample.split("\n").filter(Boolean).slice(0, 3),
      saveBookTocSettings: async (_bookId, next) => (settings = next),
      listBookmarks: async () => bookmarks,
      addBookmark: async (request) => {
        const created = {
          id: `mark-${Date.now()}`,
          contentVersion: VERSION,
          createdAt: Date.now(),
          ...request,
          note: request.note ?? "",
        };
        bookmarks.unshift(created);
        return created;
      },
      listReplaceRules: async () => replaceRules,
      saveReplaceRule: async (rule) => {
        const saved = { ...rule, id: rule.id || `rule-${Date.now()}` };
        replaceRules = [...replaceRules.filter((item) => item.id !== saved.id), saved];
        return saved;
      },
      deleteReplaceRules: async (ids) => {
        replaceRules = replaceRules.filter((rule) => !ids.includes(rule.id));
      },
      orderReplaceRules: async (ids) =>
        (replaceRules = ids.map((id) => replaceRules.find((rule) => rule.id === id)!)),
      importReplaceRules: async () => [],
      exportReplaceRules: async () => JSON.stringify(replaceRules),
      testReplaceRule: async (rule, sample) =>
        sample.replace(
          new RegExp(
            rule.isRegex ? rule.pattern : rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "gmu",
          ),
          rule.replacement,
        ),
      updateBookmarkNote: async (bookmarkId, note) => {
        const mark = bookmarks.find((item) => item.id === bookmarkId);
        if (mark) mark.note = note;
      },
      deleteBookmark: async (request) => {
        const index = bookmarks.findIndex((bookmark) => bookmark.id === request.bookmarkId);
        if (index >= 0) bookmarks.splice(index, 1);
      },
      search: async (request) => {
        // The preview approximates the Rust search: JavaScript regular
        // expressions within one line, or plain text.
        const pattern = request.regex
          ? new RegExp(request.query, "gu")
          : new RegExp(request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu");
        const matches = [];
        for (const found of TEXT.matchAll(pattern)) {
          if (matches.length >= request.limit || found[0].includes("\n")) break;
          const at = found.index ?? 0;
          matches.push({
            ordinal: matches.length,
            locator: contextFor(at),
            excerpt: TEXT.slice(Math.max(0, at - 12), at + found[0].length + 12),
            matchStart: at,
            matchEnd: at + found[0].length,
          });
        }
        return { contentVersion: VERSION, matches, nextCursor: null, hasMore: false };
      },
      cancelSearch: async () => ({ requested: true }),
    },
    settings: {
      getShelfPreferences: async () => shelf,
      saveShelfPreferences: async (next) => (shelf = next),
      getSettings: async () => preferences,
      saveSettings: async (next) => (preferences = next),
      pickAndImportFont: async () => null,
      listFonts: async () => [],
      pickBackgroundImage: async () => null,
      readFont: unsupported,
      deleteFont: unsupported,
      getNetwork: async () => network,
      saveNetwork: async (settings) => {
        network = settings;
        return settings;
      },
      networkState: async () => ({}),
      checkNetwork: async (_settings, kind) =>
        kind === "doh"
          ? { millis: 42, detail: "www.baidu.com → 110.242.68.66" }
          : { millis: 120, detail: "HTTP 200" },
    },
    sync: {
      getWebDav: async () => webdav,
      saveWebDav: async (request) =>
        (webdav = {
          ...webdav,
          ...request,
          password: request.password ?? webdav.password,
          configured: Boolean(request.url || request.username),
        }),
      testWebDav: async () => ({ latencyMs: 1240, slow: true }),
      setBackupFolder: async (clear) =>
        (webdav = { ...webdav, localFolder: clear ? null : "Download/GripRead" }),
      backupNow: async () => {
        const backup = {
          name: `manual-${Date.now()}.json`,
          size: 18_000,
          modified: Date.now(),
          automatic: false,
          device: webdav.deviceName || null,
        };
        backups = [backup, ...backups];
        webdav = { ...webdav, lastBackupAt: Date.now() };
        return backup;
      },
      runAutomaticBackup: async () => null,
      listBackups: async () => backups,
      deleteBackup: async (name) => {
        backups = backups.filter((backup) => backup.name !== name);
      },
      listRecoveryPoints: async () => [],
      pickBackupFile: async () => null,
      previewBackup: async () => ({
        createdAt: Date.now() - 86_400_000,
        device: "Android",
        books: 3,
        booksOnDevice: 1,
        bookmarks: 4,
        groups: 1,
        replaceRules: 2,
        tocRules: 0,
        hasPreferences: true,
        bookSources: 0,
        onlineBooks: 0,
      }),
      restoreBackup: async () => ({
        groupsCreated: 1,
        rulesRestored: 2,
        preferencesRestored: true,
        booksRestored: 1,
        booksPending: 2,
        positionsRestored: 1,
        bookmarksAdded: 4,
        recoveryPoint: "recovery-1.json",
        sourcesRestored: 0,
        onlineBooksRestored: 0,
      }),
      exportBackupFile: async () => false,
      listCloudBooks: async () => cloud,
      uploadBooks: async () => ({ uploaded: 0, updated: 0, skipped: 1, failed: [] }),
      downloadCloudBook: unsupported,
      deleteCloudBook: async (name) => {
        cloud = cloud.filter((book) => book.name !== name);
      },
      uploadProgress: async () => false,
      fetchProgress: async () => null,
      acknowledgeProgress: async () => undefined,
    },
    sources: createMemorySourceService(PREVIEW_SOURCES, PREVIEW_BOOKS),
  };
}

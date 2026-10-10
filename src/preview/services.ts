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
  TocEntry,
  TxtTocRule,
} from "../types/generated";
import { DEFAULT_READING_STYLE } from "../types/generated";

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
  let shelf: ShelfPreferences = { layout: "list", sort: "recent_read", groupId: "all" };
  let position: ReaderLocator | null = contextFor(ENTRIES[3].locator.offset);
  let settings: BookTocSettings = { ruleId: null, splitLongChapters: false };
  let shelfState: ShelfState | null = null;
  let readingSeconds = 1260;
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
      readingStats: async (today) => ({
        totalSeconds: readingSeconds + 5400,
        todaySeconds: readingSeconds,
        days: [
          { day: today, seconds: readingSeconds },
          { day: "2026-10-09", seconds: 3600 },
          { day: "2026-10-08", seconds: 1800 },
        ],
        books: [{ bookId: BOOK_ID, seconds: readingSeconds + 5400, lastDay: today }],
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
      updateBookmarkNote: async (bookmarkId, note) => {
        const mark = bookmarks.find((item) => item.id === bookmarkId);
        if (mark) mark.note = note;
      },
      deleteBookmark: async (request) => {
        const index = bookmarks.findIndex((bookmark) => bookmark.id === request.bookmarkId);
        if (index >= 0) bookmarks.splice(index, 1);
      },
      search: async (request) => {
        const matches = [];
        let from = request.cursor ?? 0;
        while (matches.length < request.limit) {
          const at = TEXT.indexOf(request.query, from);
          if (at < 0) break;
          matches.push({
            ordinal: matches.length,
            locator: contextFor(at),
            excerpt: TEXT.slice(Math.max(0, at - 12), at + request.query.length + 12),
            matchStart: at,
            matchEnd: at + request.query.length,
          });
          from = at + request.query.length;
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
      readFont: unsupported,
      deleteFont: unsupported,
    },
  };
}

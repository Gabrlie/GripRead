import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppServices } from "./contracts";
export type { LibraryService, ReaderService, SettingsService, AppServices } from "./contracts";
import { listen } from "@tauri-apps/api/event";

import type {
  Book,
  UpdateBookRequest,
  ShelfPreferences,
  SaveShelfPreferencesRequest,
  AppError,
  LibraryBook,
  LibraryGroup,
  CreateGroupRequest,
  RenameGroupRequest,
  GroupRequest,
  MoveBookRequest,
  ShelfPlacement,
  PickedFile,
  BookCoverRequest,
  ReadingTimeRequest,
  ReadingStats,
  ReadingStatsRequest,
  BookmarkNoteRequest,
  ReplaceRule,
  BookReplaceRequest,
  ReaderPreferences,
  ReadContentRequest,
  StartImportRequest,
  ImportOperationRequest,
  BookRequest,
  ResolveLocatorRequest,
  SaveLocatorRequest,
  SaveSettingsRequest,
  CancelResult,
  ContentWindow,
  ErrorCode,
  ImportStatus,
  ImportTask,
  ReaderLocator,
  TxtEncodingInfo,
  TxtEncodingRequest,
  TxtSourceRequest,
  TxtDecodeStatus,
  TxtDecodeTask,
  TocListing,
  BookInfo,
  BookTocSettings,
  SaveBookTocSettingsRequest,
  SaveTxtTocRuleRequest,
  TxtTocRuleIdRequest,
  OrderTxtTocRulesRequest,
  ImportTxtTocRulesRequest,
  TestTxtTocRuleRequest,
  Bookmark,
  BookmarkRequest,
  BookmarkIdRequest,
  SearchRequest,
  SearchResponse,
  TxtTocRule,
  ReaderAsset,
  ReaderAssetRequest,
  PathRequest,
} from "../types/generated";

const ERROR_CODES = new Set<ErrorCode>([
  "invalid_path",
  "file_not_found",
  "unsupported_encoding",
  "io",
  "database",
  "invalid_locator",
  "content_version_mismatch",
  "asset_missing",
  "import_cancelled",
  "not_found",
  "invalid_argument",
  "operation_not_found",
]);

export class ReaderServiceError extends Error {
  public readonly code: ErrorCode;

  public constructor(error: AppError) {
    super(`${error.code}: ${error.message}`);
    this.name = "ReaderServiceError";
    this.code = error.code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeError(value: unknown): AppError {
  if (isRecord(value)) {
    const code = value.code;
    const message = value.message;
    if (
      typeof code === "string" &&
      ERROR_CODES.has(code as ErrorCode) &&
      typeof message === "string"
    ) {
      return { code: code as ErrorCode, message };
    }
  }
  const serialized = (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  })();
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : serialized || "Tauri command failed";
  return { code: "io", message };
}

function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((error: unknown) => {
    throw new ReaderServiceError(normalizeError(error));
  });
}

export const tauriServices: AppServices = {
  library: {
    pickAndImportTxt: async (encoding) => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "TXT 文本", extensions: ["txt"] }],
      });
      if (selected === null) return null;
      if (typeof selected !== "string") throw new Error("Expected one TXT file");
      return tauriServices.library.startImport(selected, encoding);
    },
    startImport: (path, encoding) =>
      invokeCommand<ImportTask>("start_import", {
        request: {
          path,
          ...(encoding === undefined ? {} : { encoding }),
        } satisfies StartImportRequest,
      }),
    getImportStatus: (operationId) =>
      invokeCommand<ImportStatus>("get_import_status", {
        request: { operationId } satisfies ImportOperationRequest,
      }),
    cancelImport: (operationId) =>
      invokeCommand<CancelResult>("cancel_import", {
        request: { operationId } satisfies ImportOperationRequest,
      }),
    listRemovedBooks: () => invokeCommand<LibraryBook[]>("list_removed_books"),
    updateBook: (request) =>
      invokeCommand<Book>("update_book", { request: request satisfies UpdateBookRequest }),
    removeBook: (bookId) =>
      invokeCommand<void>("remove_book", { request: { bookId } satisfies BookRequest }),
    restoreBook: (bookId) =>
      invokeCommand<void>("restore_book", { request: { bookId } satisfies BookRequest }),
    listBooks: () => invokeCommand<LibraryBook[]>("list_books"),
    listGroups: () => invokeCommand<LibraryGroup[]>("list_groups"),
    createGroup: (name) =>
      invokeCommand<LibraryGroup>("create_group", {
        request: { name } satisfies CreateGroupRequest,
      }),
    renameGroup: (id, name) =>
      invokeCommand<LibraryGroup>("rename_group", {
        request: { id, name } satisfies RenameGroupRequest,
      }),
    deleteGroup: (id) =>
      invokeCommand<void>("delete_group", {
        request: { id } satisfies GroupRequest,
      }),
    moveBook: (bookId, placement: ShelfPlacement) =>
      invokeCommand<void>("move_book", {
        request: { bookId, placement } satisfies MoveBookRequest,
      }),
    pickTxtFiles: async () => {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [{ name: "TXT 文本", extensions: ["txt"] }],
      });
      if (selected === null) return [];
      return Array.isArray(selected) ? selected : [selected];
    },
    pickTxtFolder: async () => {
      // Android lists the folder inside the system picker (DocumentPlugin.kt).
      const android = /Android/i.test(navigator.userAgent);
      const folder = android ? "" : await open({ multiple: false, directory: true });
      if (folder === null || Array.isArray(folder)) return [];
      return invokeCommand<PickedFile[]>("list_txt_folder", {
        request: { path: folder } satisfies PathRequest,
      });
    },
    pickBookCover: async (bookId) => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (selected === null || Array.isArray(selected)) return false;
      await invokeCommand<ReaderAsset>("set_book_cover", {
        request: { bookId, path: selected } satisfies BookCoverRequest,
      });
      return true;
    },
    clearBookCover: (bookId) =>
      invokeCommand<void>("clear_book_cover", { request: { bookId } satisfies BookRequest }),
    readAsset: (id) =>
      invokeCommand<ArrayBuffer>("read_reader_font", {
        request: { id } satisfies ReaderAssetRequest,
      }),
    addReadingTime: (bookId, day, seconds) =>
      invokeCommand<void>("add_reading_time", {
        request: { bookId, day, seconds } satisfies ReadingTimeRequest,
      }),
    ensureTextTransforms: (bookId) =>
      invokeCommand<TxtDecodeTask | null>("ensure_text_transforms", {
        request: { bookId } satisfies BookRequest,
      }),
    setBookReplaceRules: (bookId, enabled) =>
      invokeCommand<void>("set_book_replace_rules", {
        request: { bookId, enabled } satisfies BookReplaceRequest,
      }),
    readingStats: (today) =>
      invokeCommand<ReadingStats>("reading_stats", {
        request: { today } satisfies ReadingStatsRequest,
      }),
    onImportProgress: (listener) =>
      listen<ImportStatus>("import-progress", (event) => listener(event.payload)),
    getTxtEncoding: (bookId) =>
      invokeCommand<TxtEncodingInfo>("get_txt_encoding", { request: { bookId } }),
    pickAndReassociateTxt: async (bookId) => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "TXT 文本", extensions: ["txt"] }],
      });
      if (selected === null) return null;
      if (typeof selected !== "string") throw new Error("Expected one TXT file");
      return tauriServices.library.reassociateTxtSource({ bookId, path: selected });
    },
    reassociateTxtSource: (request) =>
      invokeCommand<TxtEncodingInfo>("reassociate_txt_source", {
        request: request satisfies TxtSourceRequest,
      }),
    startTxtDecode: (request) => invokeCommand<TxtDecodeTask>("start_txt_decode", { request }),
    getTxtDecodeStatus: (operationId) =>
      invokeCommand<TxtDecodeStatus>("get_txt_decode_status", {
        request: { operationId } satisfies ImportOperationRequest,
      }),
    cancelTxtDecode: (operationId) =>
      invokeCommand<CancelResult>("cancel_txt_decode", {
        request: { operationId } satisfies ImportOperationRequest,
      }),
    onTxtDecodeProgress: (listener) =>
      listen<TxtDecodeStatus>("txt-decode-progress", (event) => listener(event.payload)),
    getBookInfo: (bookId) =>
      invokeCommand<BookInfo>("get_book_info", { request: { bookId } satisfies BookRequest }),
  },
  reader: {
    readContentWindow: (request: ReadContentRequest) =>
      invokeCommand<ContentWindow>("read_content_window", { request }),
    resolveLocator: (bookId, progress) =>
      invokeCommand<ReaderLocator>("resolve_reader_locator", {
        request: { bookId, progress } satisfies ResolveLocatorRequest,
      }),
    resolveOffset: (request) => invokeCommand<ReaderLocator>("resolve_reader_offset", { request }),
    saveReaderLocator: (locator) =>
      invokeCommand<ReaderLocator>("save_reader_locator", {
        request: { locator } satisfies SaveLocatorRequest,
      }),
    getSavedReaderLocator: (bookId) =>
      invokeCommand<ReaderLocator | null>("get_saved_reader_locator", {
        request: { bookId } satisfies BookRequest,
      }),
    listToc: (bookId) =>
      invokeCommand<TocListing>("list_toc", { request: { bookId } satisfies BookRequest }),
    listTxtTocRules: () => invokeCommand<TxtTocRule[]>("list_txt_toc_rules"),
    saveTxtTocRule: (rule) =>
      invokeCommand<TxtTocRule>("save_txt_toc_rule", {
        request: { rule } satisfies SaveTxtTocRuleRequest,
      }),
    deleteTxtTocRule: (id) =>
      invokeCommand<void>("delete_txt_toc_rule", {
        request: { id } satisfies TxtTocRuleIdRequest,
      }),
    orderTxtTocRules: (ids) =>
      invokeCommand<TxtTocRule[]>("order_txt_toc_rules", {
        request: { ids } satisfies OrderTxtTocRulesRequest,
      }),
    importTxtTocRules: (json) =>
      invokeCommand<TxtTocRule[]>("import_txt_toc_rules", {
        request: { json } satisfies ImportTxtTocRulesRequest,
      }),
    exportTxtTocRules: () => invokeCommand<string>("export_txt_toc_rules"),
    testTxtTocRule: (pattern, sample) =>
      invokeCommand<string[]>("test_txt_toc_rule", {
        request: { pattern, sample } satisfies TestTxtTocRuleRequest,
      }),
    saveBookTocSettings: (bookId, settings) =>
      invokeCommand<BookTocSettings>("save_book_toc_settings", {
        request: { bookId, settings } satisfies SaveBookTocSettingsRequest,
      }),
    listBookmarks: (bookId) => invokeCommand<Bookmark[]>("list_bookmarks", { request: { bookId } }),
    addBookmark: (request) => invokeCommand<Bookmark>("add_bookmark", { request }),
    deleteBookmark: (request) => invokeCommand<void>("delete_bookmark", { request }),
    listReplaceRules: () => invokeCommand<ReplaceRule[]>("list_replace_rules"),
    saveReplaceRule: (rule) =>
      invokeCommand<ReplaceRule>("save_replace_rule", { request: { rule } }),
    deleteReplaceRules: (ids) => invokeCommand<void>("delete_replace_rules", { request: { ids } }),
    orderReplaceRules: (ids) =>
      invokeCommand<ReplaceRule[]>("order_replace_rules", { request: { ids } }),
    importReplaceRules: (json) =>
      invokeCommand<ReplaceRule[]>("import_replace_rules", { request: { json } }),
    exportReplaceRules: () => invokeCommand<string>("export_replace_rules"),
    testReplaceRule: (rule, sample) =>
      invokeCommand<string>("test_replace_rule", { request: { rule, sample } }),
    updateBookmarkNote: (bookmarkId, note) =>
      invokeCommand<void>("update_bookmark_note", {
        request: { bookmarkId, note } satisfies BookmarkNoteRequest,
      }),
    search: (request) => invokeCommand<SearchResponse>("search_book", { request }),
    cancelSearch: (operationId) =>
      invokeCommand<CancelResult>("cancel_search", {
        request: { operationId } satisfies ImportOperationRequest,
      }),
  },
  settings: {
    getShelfPreferences: () => invokeCommand<ShelfPreferences>("get_shelf_preferences"),
    saveShelfPreferences: (preferences) =>
      invokeCommand<ShelfPreferences>("save_shelf_preferences", {
        request: { preferences } satisfies SaveShelfPreferencesRequest,
      }),
    getSettings: () => invokeCommand<ReaderPreferences>("get_settings"),
    saveSettings: (settings) =>
      invokeCommand<ReaderPreferences>("save_settings", {
        request: { settings } satisfies SaveSettingsRequest,
      }),
    pickAndImportFont: async () => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "字体", extensions: ["ttf", "otf", "ttc", "woff", "woff2"] }],
      });
      if (selected === null) return null;
      if (typeof selected !== "string") throw new Error("Expected one font file");
      return invokeCommand<ReaderAsset>("import_reader_font", {
        request: { path: selected } satisfies PathRequest,
      });
    },
    listFonts: () => invokeCommand<ReaderAsset[]>("list_reader_fonts"),
    pickBackgroundImage: async () => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (selected === null || Array.isArray(selected)) return null;
      return invokeCommand<ReaderAsset>("import_reader_background", {
        request: { path: selected } satisfies PathRequest,
      });
    },
    readFont: (id) =>
      invokeCommand<ArrayBuffer>("read_reader_font", {
        request: { id } satisfies ReaderAssetRequest,
      }),
    deleteFont: (id) =>
      invokeCommand<void>("delete_reader_font", {
        request: { id } satisfies ReaderAssetRequest,
      }),
  },
};

import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppServices } from "./contracts";
import { appLog } from "./log";
export type { LibraryService, ReaderService, SettingsService, AppServices } from "./contracts";
import { listen } from "@tauri-apps/api/event";

import type {
  SearchOnlineRequest,
  OnlineSearchEvent,
  ExploreKind,
  ExploreKindsRequest,
  ExploreBooksRequest,
  OnlineBook,
  OnlineBookRequest,
  OnlineChapter,
  OnlineContent,
  OnlineContentRequest,
  OnlineCoverRequest,
  BookSourceSummary,
  BookSourceDetail,
  SourceImportPreview,
  ImportSourcesRequest,
  PreviewSourceImportRequest,
  SourceUrlRequest,
  SourceUrlsRequest,
  SetSourcesSwitchRequest,
  SourceGroupRequest,
  MoveSourcesRequest,
  SaveBookSourceRequest,
  FetchTextRequest,
  ExportSourcesFileRequest,
  SourceLoginForm,
  SourceLoginRequest,
  SourceScriptReport,
  SourceVariableRequest,
  DebugSourceRequest,
  SourceDebugEvent,
  CheckSourcesRequest,
  SourceCheckEvent,
  WebDavSettings,
  SaveWebDavRequest,
  RemoteBackup,
  BackupSource,
  BackupSourceRequest,
  BackupPreview,
  RestoreReport,
  CloudBook,
  CloudUploadReport,
  NameRequest,
  BookIdListRequest,
  OptionalPathRequest,
  WebDavCheck,
  ProgressPrompt,
  UploadProgressRequest,
  AcknowledgeProgressRequest,
  DeleteBookRequest,
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
  AddOnlineBookRequest,
  UpdateOnlineTocRequest,
  OnlineTocEvent,
  SetOnlineBookFlagRequest,
  FindOnlineBookRequest,
  ChangeOnlineSourceRequest,
  ChangeOnlineSourceResult,
  SourceCoverRequest,
  ClearDataRequest,
  DataUsage,
  DownloadJob,
  NetworkCheck,
  NetworkCheckRequest,
  NetworkSettings,
  DownloadJobRequest,
  DownloadRequest,
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

/** Failures that are an answer rather than a fault stay out of the log. */
const QUIET_CODES = new Set([
  "import_cancelled",
  "operation_not_found",
  "content_version_mismatch",
]);

function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((error: unknown) => {
    const normalized = normalizeError(error);
    if (!QUIET_CODES.has(normalized.code))
      appLog.write("warn", "command", `${command}：${normalized.message}`);
    throw new ReaderServiceError(normalized);
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
    deleteBook: (bookId, cloud) =>
      invokeCommand<void>("delete_book", {
        request: { bookId, cloud } satisfies DeleteBookRequest,
      }),
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
    deleteReadingRecord: (bookId) =>
      invokeCommand<void>("delete_reading_record", { request: { bookId } satisfies BookRequest }),
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
    getNetwork: () => invokeCommand<NetworkSettings>("get_network_settings"),
    saveNetwork: (settings) =>
      invokeCommand<NetworkSettings>("save_network_settings", { request: settings }),
    checkNetwork: (settings, kind) =>
      invokeCommand<NetworkCheck>("check_network", {
        request: { settings, kind } satisfies NetworkCheckRequest,
      }),
  },
  sync: {
    getWebDav: () => invokeCommand<WebDavSettings>("get_webdav_settings"),
    saveWebDav: (request) =>
      invokeCommand<WebDavSettings>("save_webdav_settings", {
        request: request satisfies SaveWebDavRequest,
      }),
    testWebDav: (request) =>
      invokeCommand<WebDavCheck>("test_webdav", { request: request satisfies SaveWebDavRequest }),
    setBackupFolder: async (clear) => {
      // Android shows its own folder picker (DocumentPlugin.kt).
      const android = /Android/i.test(navigator.userAgent);
      let path: string | null = clear ? "" : null;
      if (!clear && !android) {
        const picked = await open({ multiple: false, directory: true });
        if (picked === null || Array.isArray(picked))
          return invokeCommand<WebDavSettings>("get_webdav_settings");
        path = picked;
      }
      return invokeCommand<WebDavSettings>("set_backup_folder", {
        request: { path } satisfies OptionalPathRequest,
      });
    },
    backupNow: () => invokeCommand<RemoteBackup>("backup_to_webdav"),
    runAutomaticBackup: () => invokeCommand<RemoteBackup | null>("run_automatic_backup"),
    listBackups: () => invokeCommand<RemoteBackup[]>("list_remote_backups"),
    deleteBackup: (name) =>
      invokeCommand<void>("delete_remote_backup", { request: { name } satisfies NameRequest }),
    listRecoveryPoints: () => invokeCommand<string[]>("list_recovery_points"),
    pickBackupFile: async () => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "GripRead 备份", extensions: ["json"] }],
      });
      if (selected === null || Array.isArray(selected)) return null;
      return { kind: "file", name: selected } satisfies BackupSource;
    },
    previewBackup: (source) =>
      invokeCommand<BackupPreview>("preview_backup", {
        request: { source } satisfies BackupSourceRequest,
      }),
    restoreBackup: (source) =>
      invokeCommand<RestoreReport>("restore_backup", {
        request: { source } satisfies BackupSourceRequest,
      }),
    exportBackupFile: async () => {
      // Android shows its own "save as" screen (DocumentPlugin.kt).
      const android = /Android/i.test(navigator.userAgent);
      const path = android
        ? null
        : await save({
            defaultPath: `gripread-backup-${new Date().toISOString().slice(0, 10)}.json`,
            filters: [{ name: "GripRead 备份", extensions: ["json"] }],
          });
      if (!android && path === null) return false;
      return invokeCommand<boolean>("export_backup_file", {
        request: { path } satisfies OptionalPathRequest,
      });
    },
    listCloudBooks: () => invokeCommand<CloudBook[]>("list_cloud_books"),
    uploadBooks: (bookIds) =>
      invokeCommand<CloudUploadReport>("upload_cloud_books", {
        request: { bookIds } satisfies BookIdListRequest,
      }),
    downloadCloudBook: (name) =>
      invokeCommand<PickedFile>("download_cloud_book", {
        request: { name } satisfies NameRequest,
      }),
    deleteCloudBook: (name) =>
      invokeCommand<void>("delete_cloud_book", { request: { name } satisfies NameRequest }),
    uploadProgress: (bookId, chapterTitle) =>
      invokeCommand<boolean>("upload_book_progress", {
        request: { bookId, chapterTitle } satisfies UploadProgressRequest,
      }),
    fetchProgress: (bookId) =>
      invokeCommand<ProgressPrompt | null>("fetch_book_progress", {
        request: { bookId } satisfies BookRequest,
      }),
    acknowledgeProgress: (bookId, deviceId, revision) =>
      invokeCommand<void>("acknowledge_book_progress", {
        request: { bookId, deviceId, revision } satisfies AcknowledgeProgressRequest,
      }),
  },
  sources: {
    listSources: () => invokeCommand<BookSourceSummary[]>("list_book_sources"),
    getSource: (url) =>
      invokeCommand<BookSourceDetail>("get_book_source", {
        request: { url } satisfies SourceUrlRequest,
      }),
    previewImport: (json) =>
      invokeCommand<SourceImportPreview>("preview_source_import", {
        request: { json } satisfies PreviewSourceImportRequest,
      }),
    importSources: (request) =>
      invokeCommand<BookSourceSummary[]>("import_book_sources", {
        request: request satisfies ImportSourcesRequest,
      }),
    fetchText: (url) =>
      invokeCommand<string>("fetch_source_text", { request: { url } satisfies FetchTextRequest }),
    pickSourceFile: async () => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "书源", extensions: ["json", "txt"] }],
      });
      if (selected === null || Array.isArray(selected)) return null;
      return invokeCommand<string>("read_source_file", {
        request: { path: selected } satisfies PathRequest,
      });
    },
    saveSource: (json, previousUrl) =>
      invokeCommand<BookSourceSummary>("save_book_source", {
        request: { json, previousUrl: previousUrl ?? null } satisfies SaveBookSourceRequest,
      }),
    deleteSources: (urls) =>
      invokeCommand<void>("delete_book_sources", { request: { urls } satisfies SourceUrlsRequest }),
    setSwitch: (urls, which, on) =>
      invokeCommand<void>("set_book_sources_switch", {
        request: { urls, switch: which, on } satisfies SetSourcesSwitchRequest,
      }),
    changeGroup: (urls, group, add) =>
      invokeCommand<void>("change_book_sources_group", {
        request: { urls, group, add } satisfies SourceGroupRequest,
      }),
    moveSources: (urls, top) =>
      invokeCommand<void>("move_book_sources", {
        request: { urls, top } satisfies MoveSourcesRequest,
      }),
    exportSources: (urls) =>
      invokeCommand<string>("export_book_sources", {
        request: { urls } satisfies SourceUrlsRequest,
      }),
    exportSourcesFile: async (urls) => {
      // Android shows its own "save as" screen (DocumentPlugin.kt).
      const android = /Android/i.test(navigator.userAgent);
      const path = android
        ? null
        : await save({
            defaultPath: "bookSource.json",
            filters: [{ name: "书源", extensions: ["json"] }],
          });
      if (!android && path === null) return false;
      return invokeCommand<boolean>("export_book_sources_file", {
        request: { path, urls } satisfies ExportSourcesFileRequest,
      });
    },
    getLoginForm: (url) =>
      invokeCommand<SourceLoginForm>("get_source_login_form", {
        request: { url } satisfies SourceUrlRequest,
      }),
    login: (request) =>
      invokeCommand<SourceScriptReport>("login_book_source", {
        request: request satisfies SourceLoginRequest,
      }),
    getVariable: (url) =>
      invokeCommand<string | null>("get_source_variable", {
        request: { url } satisfies SourceUrlRequest,
      }),
    setVariable: (url, value) =>
      invokeCommand<void>("set_source_variable", {
        request: { url, value } satisfies SourceVariableRequest,
      }),
    clearCookies: (url) =>
      invokeCommand<void>("clear_source_cookies", { request: { url } satisfies SourceUrlRequest }),
    debug: (request) =>
      invokeCommand<void>("debug_book_source", { request: request satisfies DebugSourceRequest }),
    onDebug: (listener) =>
      listen<SourceDebugEvent>("source-debug", (event) => listener(event.payload)),
    check: (request) =>
      invokeCommand<void>("check_book_sources", {
        request: request satisfies CheckSourcesRequest,
      }),
    onCheck: (listener) =>
      listen<SourceCheckEvent>("source-check", (event) => listener(event.payload)),
    cancel: (operationId) =>
      invokeCommand<CancelResult>("cancel_source_operation", {
        request: { operationId } satisfies ImportOperationRequest,
      }),
    search: (request) =>
      invokeCommand<void>("search_online_books", {
        request: request satisfies SearchOnlineRequest,
      }),
    onSearch: (listener) =>
      listen<OnlineSearchEvent>("online-search", (event) => listener(event.payload)),
    exploreKinds: (sourceUrl, refresh = false) =>
      invokeCommand<ExploreKind[]>("explore_kinds", {
        request: { sourceUrl, refresh } satisfies ExploreKindsRequest,
      }),
    exploreBooks: (sourceUrl, url, page) =>
      invokeCommand<OnlineBook[]>("explore_books", {
        request: { sourceUrl, url, page } satisfies ExploreBooksRequest,
      }),
    bookInfo: (book, refresh = false) =>
      invokeCommand<OnlineBook>("online_book_info", {
        request: { book, refresh } satisfies OnlineBookRequest,
      }),
    chapters: (book, refresh = false) =>
      invokeCommand<OnlineChapter[]>("online_book_chapters", {
        request: { book, refresh } satisfies OnlineBookRequest,
      }),
    dataUsage: () => invokeCommand<DataUsage>("data_usage"),
    clearData: (parts) =>
      invokeCommand<void>("clear_data", { request: { parts } satisfies ClearDataRequest }),
    convertToLocal: (bookId) =>
      invokeCommand<LibraryBook>("convert_online_to_local", {
        request: { bookId } satisfies BookRequest,
      }),
    setCoverFromSource: (bookId, sourceUrl, url) =>
      invokeCommand<void>("set_cover_from_source", {
        request: { bookId, sourceUrl, url } satisfies SourceCoverRequest,
      }),
    chapterContent: (book, chapter, nextChapterUrl) =>
      invokeCommand<OnlineContent>("online_chapter_content", {
        request: { book, chapter, nextChapterUrl } satisfies OnlineContentRequest,
      }),
    cover: (sourceUrl, url) =>
      invokeCommand<ArrayBuffer>("online_cover", {
        request: { sourceUrl, url } satisfies OnlineCoverRequest,
      }),
    addOnlineBook: (request) =>
      invokeCommand<LibraryBook>("add_online_book", {
        request: request satisfies AddOnlineBookRequest,
      }),
    changeSource: (request) =>
      invokeCommand<ChangeOnlineSourceResult>("change_online_source", {
        request: request satisfies ChangeOnlineSourceRequest,
      }),
    findOnlineBook: (name, author) =>
      invokeCommand<LibraryBook | null>("find_online_book", {
        request: { name, author } satisfies FindOnlineBookRequest,
      }),
    getLibraryBook: (bookId) =>
      invokeCommand<LibraryBook>("get_library_book", {
        request: { bookId } satisfies BookRequest,
      }),
    setOnShelf: (bookId, on) =>
      invokeCommand<void>("set_online_on_shelf", {
        request: { bookId, on } satisfies SetOnlineBookFlagRequest,
      }),
    setCanUpdate: (bookId, on) =>
      invokeCommand<void>("set_online_can_update", {
        request: { bookId, on } satisfies SetOnlineBookFlagRequest,
      }),
    leaveOnlineBook: (bookId) =>
      invokeCommand<boolean>("leave_online_book", {
        request: { bookId } satisfies BookRequest,
      }),
    listOnlineChapters: (bookId) =>
      invokeCommand<OnlineChapter[]>("list_online_chapters", {
        request: { bookId } satisfies BookRequest,
      }),
    clearOnlineCache: (bookId) =>
      invokeCommand<void>("clear_online_cache", {
        request: { bookId } satisfies BookRequest,
      }),
    updateToc: (request) =>
      invokeCommand<void>("update_online_toc", {
        request: request satisfies UpdateOnlineTocRequest,
      }),
    onTocUpdate: (listener) =>
      listen<OnlineTocEvent>("online-toc", (event) => listener(event.payload)),
    enqueueDownload: (bookId, start, end) =>
      invokeCommand<DownloadJob>("download_enqueue", {
        request: { bookId, start, end } satisfies DownloadRequest,
      }),
    listDownloads: () => invokeCommand<DownloadJob[]>("download_list"),
    pauseDownload: (id) =>
      invokeCommand<void>("download_pause", { request: { id } satisfies DownloadJobRequest }),
    resumeDownload: (id) =>
      invokeCommand<void>("download_resume", { request: { id } satisfies DownloadJobRequest }),
    cancelDownload: (id) =>
      invokeCommand<void>("download_cancel", { request: { id } satisfies DownloadJobRequest }),
    pauseAllDownloads: () => invokeCommand<void>("download_pause_all"),
    clearFinishedDownloads: () => invokeCommand<void>("download_clear_finished"),
    onDownloads: (listener) =>
      listen<DownloadJob[]>("download-progress", (event) => listener(event.payload)),
    onDownloadStop: async (listener) => {
      // Only the Android plugin has the notification; elsewhere nothing stops it.
      try {
        const handle = await addPluginListener("gripread-downloads", "stop", listener);
        return () => void handle.unregister();
      } catch {
        return () => undefined;
      }
    },
  },
};

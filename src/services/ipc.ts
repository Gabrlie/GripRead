import { addPluginListener } from "@tauri-apps/api/core";
import { errorText, t } from "../i18n";
import type { AppServices } from "./contracts";
import { appLog, errorParams } from "./log";
import { androidApp, call, listen, native } from "./transport";
import { finishSave, pickFiles, pickSaveTarget, pickTxtFolderFiles } from "./files";
export type { LibraryService, ReaderService, SettingsService, AppServices } from "./contracts";

import type {
  BookImage,
  BookImageRequest,
  ComicChapter,
  ComicChapterRequest,
  ComicPageRequest,
  CheckUpdateRequest,
  InstallOutcome,
  InstallUpdateRequest,
  SaveUpdateSettingsRequest,
  UpdateCheck,
  UpdateProgress,
  UpdateSettings,
  BookLanguageRequest,
  BookTranslation,
  BookTranslationRequest,
  BookTranslationEvent,
  ChapterTranslationEvent,
  TranslateBookRequest,
  TranslateTextsRequest,
  TestEngineRequest,
  TranslationSettings,
} from "../types/generated";
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
  SourceViaServerRequest,
  SourceUrlsRequest,
  SetSourcesSwitchRequest,
  SourceGroupRequest,
  MoveSourcesRequest,
  SaveBookSourceRequest,
  FetchTextRequest,
  ExportSourcesFileRequest,
  SourceLoginForm,
  SourceLoginRequest,
  SourceNotice,
  SourceSubscription,
  SubscriptionImportedRequest,
  SubscriptionRequest,
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
  ReplaceRuleImportPreview,
  BookReplaceRequest,
  ReaderPreferences,
  ReadContentRequest,
  StartImportRequest,
  ImportOperationRequest,
  BookRequest,
  ListTocRequest,
  SaveGroupPrivacyRequest,
  UnlockGroupRequest,
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
  TocSuggestion,
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
  NetworkState,
  SyncServerStatus,
  ConnectSyncServerRequest,
  SwitchRequest,
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
  /** What the reader is shown: the message alone, in the interface's language when keyed. */
  public readonly text: string;

  public constructor(error: AppError) {
    const text = errorText(error);
    super(`${error.code}: ${text}`);
    this.name = "ReaderServiceError";
    this.code = error.code;
    this.text = text;
  }

  /** Pages show failures with `String(failure)`; they get the readable text. */
  public override toString(): string {
    return this.text;
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
      return {
        code: code as ErrorCode,
        message,
        key: typeof value.key === "string" ? value.key : undefined,
        params: isRecord(value.params) ? (value.params as Record<string, string>) : undefined,
      };
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

export function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return call<T>(command, args).catch((error: unknown) => {
    const normalized = normalizeError(error);
    if (!QUIET_CODES.has(normalized.code))
      appLog.write("warn", "command", `${command}：${normalized.message}`, {
        key: "commandFailed",
        params: { command, ...errorParams(normalized) },
      });
    throw new ReaderServiceError(normalized);
  });
}

/** The books the library imports. */
const BOOK_FILES = [{ name: "TXT / EPUB / CBZ", extensions: ["txt", "epub", "cbz", "zip"] }];

export const tauriServices: AppServices = {
  library: {
    pickAndImportTxt: async (encoding) => {
      const selected = await pickFiles({ filters: BOOK_FILES });
      if (selected === null) return null;
      if (typeof selected !== "string") throw new Error("Expected one book file");
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
    deleteGroup: (id, password) =>
      invokeCommand<void>("delete_group", {
        request: { id, password } satisfies GroupRequest,
      }),
    saveGroupPrivacy: (request) =>
      invokeCommand<LibraryGroup>("save_group_privacy", {
        request: request satisfies SaveGroupPrivacyRequest,
      }),
    unlockGroup: (id, password) =>
      invokeCommand<void>("unlock_group", {
        request: { id, password } satisfies UnlockGroupRequest,
      }),
    moveBook: (bookId, placement: ShelfPlacement) =>
      invokeCommand<void>("move_book", {
        request: { bookId, placement } satisfies MoveBookRequest,
      }),
    pickTxtFiles: async () => {
      const selected = await pickFiles({ multiple: true, filters: BOOK_FILES });
      return selected;
    },
    pickTxtFolder: async () => {
      // Android lists the folder inside the system picker (DocumentPlugin.kt);
      // the web version uploads the folder's TXT files.
      const folder = androidApp() ? "" : await pickTxtFolderFiles();
      if (folder === null) return [];
      if (typeof folder !== "string") return folder;
      return invokeCommand<PickedFile[]>("list_txt_folder", {
        request: { path: folder } satisfies PathRequest,
      });
    },
    pickBookCover: async (bookId) => {
      const selected = await pickFiles({
        filters: [{ name: t("files.images"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
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
    onImportProgress: (listener) => listen<ImportStatus>("import-progress", listener),
    getTxtEncoding: (bookId) =>
      invokeCommand<TxtEncodingInfo>("get_txt_encoding", { request: { bookId } }),
    pickAndReassociateTxt: async (bookId) => {
      const selected = await pickFiles({
        filters: [{ name: t("files.txt"), extensions: ["txt"] }],
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
    onTxtDecodeProgress: (listener) => listen<TxtDecodeStatus>("txt-decode-progress", listener),
    listBookImages: (bookId) =>
      invokeCommand<BookImage[]>("list_book_images", { request: { bookId } }),
    readBookImage: (bookId, index) =>
      invokeCommand<ArrayBuffer>("read_book_image", {
        request: { bookId, index } satisfies BookImageRequest,
      }),
    getComicChapter: (bookId, index) =>
      invokeCommand<ComicChapter>("get_comic_chapter", {
        request: { bookId, index } satisfies ComicChapterRequest,
      }),
    readComicPage: (bookId, chapter, page) =>
      invokeCommand<ArrayBuffer>("read_comic_page", {
        request: { bookId, chapter, page } satisfies ComicPageRequest,
      }),
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
    listToc: (bookId, options) =>
      invokeCommand<TocListing>("list_toc", {
        request: { bookId, rebuild: options?.rebuild } satisfies ListTocRequest,
      }),
    tocSuggestion: (bookId) =>
      invokeCommand<TocSuggestion | null>("toc_suggestion", {
        request: { bookId } satisfies BookRequest,
      }),
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
    previewReplaceRules: (json) =>
      invokeCommand<ReplaceRuleImportPreview>("preview_replace_rules", { request: { json } }),
    importReplaceRules: (json, chosen) =>
      invokeCommand<ReplaceRule[]>("import_replace_rules", { request: { json, chosen } }),
    exportReplaceRules: () => invokeCommand<string>("export_replace_rules"),
    fetchRuleText: (url) =>
      invokeCommand<string>("fetch_source_text", { request: { url } satisfies FetchTextRequest }),
    pickRuleFile: async () => {
      const selected = await pickFiles({
        filters: [{ name: t("files.rules"), extensions: ["json", "txt"] }],
      });
      if (selected === null || Array.isArray(selected)) return null;
      return invokeCommand<string>("read_source_file", {
        request: { path: selected } satisfies PathRequest,
      });
    },
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
      const selected = await pickFiles({
        filters: [{ name: t("files.fonts"), extensions: ["ttf", "otf", "ttc", "woff", "woff2"] }],
      });
      if (selected === null) return null;
      if (typeof selected !== "string") throw new Error("Expected one font file");
      return invokeCommand<ReaderAsset>("import_reader_font", {
        request: { path: selected } satisfies PathRequest,
      });
    },
    listFonts: () => invokeCommand<ReaderAsset[]>("list_reader_fonts"),
    pickBackgroundImage: async () => {
      const selected = await pickFiles({
        filters: [{ name: t("files.images"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
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
    networkState: () => invokeCommand<NetworkState>("network_state"),
    onNetworkChange: async (listener) => {
      // Only the Android plugin reports changes.
      try {
        const handle = await addPluginListener("gripread-network", "changed", listener);
        return () => void handle.unregister();
      } catch {
        return () => undefined;
      }
    },
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
      let path: string | null = clear ? "" : null;
      if (!clear && !androidApp()) {
        const picked = native ? await pickTxtFolderFiles() : null;
        if (typeof picked !== "string") return invokeCommand<WebDavSettings>("get_webdav_settings");
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
    deleteRecoveryPoint: (name) =>
      invokeCommand<void>("delete_recovery_point", { request: { name } satisfies NameRequest }),
    pickBackupFile: async () => {
      const selected = await pickFiles({
        filters: [{ name: t("files.backups"), extensions: ["json"] }],
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
      const android = androidApp();
      const path = android
        ? null
        : await pickSaveTarget({
            defaultPath: `gripread-backup-${new Date().toISOString().slice(0, 10)}.json`,
            filters: [{ name: t("files.backups"), extensions: ["json"] }],
          });
      if (!android && path === null) return false;
      return finishSave(
        await invokeCommand<boolean>("export_backup_file", {
          request: { path } satisfies OptionalPathRequest,
        }),
      );
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
    acknowledgeProgress: (bookId, deviceId, revision, locator) =>
      invokeCommand<void>("acknowledge_book_progress", {
        request: { bookId, deviceId, revision, locator } satisfies AcknowledgeProgressRequest,
      }),
    getServer: () => invokeCommand<SyncServerStatus>("get_sync_server"),
    connectServer: (request) =>
      invokeCommand<SyncServerStatus>("connect_sync_server", {
        request: request satisfies ConnectSyncServerRequest,
      }),
    disconnectServer: () => invokeCommand<SyncServerStatus>("disconnect_sync_server"),
    forgetServerLogin: () => invokeCommand<SyncServerStatus>("forget_sync_server_login"),
    syncServerNow: () => invokeCommand<void>("sync_now"),
    setServerAutoDownload: (on) =>
      invokeCommand<SyncServerStatus>("set_sync_auto_download", {
        request: { on } satisfies SwitchRequest,
      }),
    setServerUpdateViaServer: (on) =>
      invokeCommand<SyncServerStatus>("set_sync_update_via_server", {
        request: { on } satisfies SwitchRequest,
      }),
    setSyncOpenBook: (bookId) =>
      invokeCommand<void>("set_sync_open_book", {
        request: { path: bookId } satisfies OptionalPathRequest,
      }),
    onServerStatus: (listener) => listen<SyncServerStatus>("sync-status", listener),
    onSyncApplied: (listener) => listen<null>("sync-applied", () => listener()),
    onSyncProgress: (listener) =>
      listen<{ bookId: string }>("sync-progress", (payload) => listener(payload.bookId)),
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
      const selected = await pickFiles({
        filters: [{ name: t("settings.sources"), extensions: ["json", "txt"] }],
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
      const android = androidApp();
      const path = android
        ? null
        : await pickSaveTarget({
            defaultPath: "bookSource.json",
            filters: [{ name: t("settings.sources"), extensions: ["json"] }],
          });
      if (!android && path === null) return false;
      return finishSave(
        await invokeCommand<boolean>("export_book_sources_file", {
          request: { path, urls } satisfies ExportSourcesFileRequest,
        }),
      );
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
    setViaServer: (urls, on) =>
      invokeCommand<void>("set_sources_via_server", {
        request: { urls, on } satisfies SourceViaServerRequest,
      }),
    debug: (request) =>
      invokeCommand<void>("debug_book_source", { request: request satisfies DebugSourceRequest }),
    onDebug: (listener) => listen<SourceDebugEvent>("source-debug", listener),
    onNotice: (listener) => listen<SourceNotice>("source-notice", listener),
    listSubscriptions: () => invokeCommand<SourceSubscription[]>("list_source_subscriptions"),
    saveSubscription: (subscription) =>
      invokeCommand<SourceSubscription[]>("save_source_subscription", { request: subscription }),
    deleteSubscription: (id) =>
      invokeCommand<SourceSubscription[]>("delete_source_subscription", {
        request: { id } satisfies SubscriptionRequest,
      }),
    subscriptionImported: (id, count) =>
      invokeCommand<SourceSubscription[]>("source_subscription_imported", {
        request: { id, count } satisfies SubscriptionImportedRequest,
      }),
    check: (request) =>
      invokeCommand<void>("check_book_sources", {
        request: request satisfies CheckSourcesRequest,
      }),
    onCheck: (listener) => listen<SourceCheckEvent>("source-check", listener),
    cancel: (operationId) =>
      invokeCommand<CancelResult>("cancel_source_operation", {
        request: { operationId } satisfies ImportOperationRequest,
      }),
    search: (request) =>
      invokeCommand<void>("search_online_books", {
        request: request satisfies SearchOnlineRequest,
      }),
    onSearch: (listener) => listen<OnlineSearchEvent>("online-search", listener),
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
    onTocUpdate: (listener) => listen<OnlineTocEvent>("online-toc", listener),
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
    onDownloads: (listener) => listen<DownloadJob[]>("download-progress", listener),
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
  updates: {
    getSettings: () => invokeCommand<UpdateSettings>("get_update_settings"),
    saveSettings: (request) =>
      invokeCommand<UpdateSettings>("save_update_settings", {
        request: request satisfies SaveUpdateSettingsRequest,
      }),
    check: (current, automatic) =>
      invokeCommand<UpdateCheck>("check_update", {
        request: { current, automatic } satisfies CheckUpdateRequest,
      }),
    install: (operationId, version) =>
      invokeCommand<InstallOutcome>("install_update", {
        request: { operationId, version } satisfies InstallUpdateRequest,
      }),
    cancel: (operationId) =>
      invokeCommand<CancelResult>("cancel_source_operation", {
        request: { operationId } satisfies ImportOperationRequest,
      }),
    onProgress: (listener) => listen<UpdateProgress>("update-progress", listener),
  },
  translation: {
    getSettings: () => invokeCommand<TranslationSettings>("get_translation_settings"),
    saveSettings: (settings) =>
      invokeCommand<TranslationSettings>("save_translation_settings", { request: settings }),
    testEngine: (engine, target) =>
      invokeCommand<string>("test_translation_engine", {
        request: { engine, target } satisfies TestEngineRequest,
      }),
    getBook: (bookId) =>
      invokeCommand<BookTranslation>("get_book_translation", {
        request: { bookId } satisfies BookRequest,
      }),
    setBook: (bookId, translateTo) =>
      invokeCommand<BookTranslation>("set_book_translation", {
        request: { bookId, translateTo } satisfies BookTranslationRequest,
      }),
    setLanguage: (bookId, language) =>
      invokeCommand<BookTranslation>("set_book_language", {
        request: { bookId, language } satisfies BookLanguageRequest,
      }),
    translateBook: (bookId, whole) =>
      invokeCommand<void>("translate_book", {
        request: { bookId, whole } satisfies TranslateBookRequest,
      }),
    stopBook: async (bookId) => {
      await invokeCommand<CancelResult>("cancel_source_operation", {
        request: { operationId: `translate:${bookId}` } satisfies ImportOperationRequest,
      });
    },
    onBookProgress: (listener) => listen<BookTranslationEvent>("book-translation", listener),
    detectLanguages: (texts) =>
      invokeCommand<(string | null)[]>("detect_languages", {
        request: { texts } satisfies TranslateTextsRequest,
      }),
    translateTexts: (texts) =>
      invokeCommand<(string | null)[]>("translate_texts", {
        request: { texts } satisfies TranslateTextsRequest,
      }),
    onChapterProgress: (listener) =>
      listen<ChapterTranslationEvent>("chapter-translation", listener),
  },
};

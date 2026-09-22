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
  SetBookGroupsRequest,
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
  TocEntry,
  Bookmark,
  BookmarkRequest,
  BookmarkIdRequest,
  SearchRequest,
  SearchResponse,
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
    pickAndImportTxt: async () => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "TXT 文本", extensions: ["txt"] }],
      });
      if (selected === null) return null;
      if (typeof selected !== "string") throw new Error("Expected one TXT file");
      return tauriServices.library.startImport(selected);
    },
    startImport: (path) =>
      invokeCommand<ImportTask>("start_import", { request: { path } satisfies StartImportRequest }),
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
    setBookGroups: (bookId, groupIds) =>
      invokeCommand<void>("set_book_groups", {
        request: { bookId, groupIds } satisfies SetBookGroupsRequest,
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
  },
  reader: {
    readContentWindow: (request: ReadContentRequest) =>
      invokeCommand<ContentWindow>("read_content_window", { request }),
    resolveLocator: (bookId, progress) =>
      invokeCommand<ReaderLocator>("resolve_reader_locator", {
        request: { bookId, progress } satisfies ResolveLocatorRequest,
      }),
    saveReaderLocator: (locator) =>
      invokeCommand<ReaderLocator>("save_reader_locator", {
        request: { locator } satisfies SaveLocatorRequest,
      }),
    getSavedReaderLocator: (bookId) =>
      invokeCommand<ReaderLocator | null>("get_saved_reader_locator", {
        request: { bookId } satisfies BookRequest,
      }),
    listToc: (bookId) => invokeCommand<TocEntry[]>("list_toc", { request: { bookId } }),
    listBookmarks: (bookId) => invokeCommand<Bookmark[]>("list_bookmarks", { request: { bookId } }),
    addBookmark: (request) => invokeCommand<Bookmark>("add_bookmark", { request }),
    deleteBookmark: (request) => invokeCommand<void>("delete_bookmark", { request }),
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
  },
};

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppServices } from "./contracts";
export type { LibraryService, ReaderService, SettingsService, AppServices } from "./contracts";
import { listen } from "@tauri-apps/api/event";

import type {
  AppError,
  LibraryBook,
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
        filters: [{ name: "UTF-8 TXT", extensions: ["txt"] }],
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
    listBooks: () => invokeCommand<LibraryBook[]>("list_books"),
    onImportProgress: (listener) =>
      listen<ImportStatus>("import-progress", (event) => listener(event.payload)),
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
  },
  settings: {
    getSettings: () => invokeCommand<ReaderPreferences>("get_settings"),
    saveSettings: (settings) =>
      invokeCommand<ReaderPreferences>("save_settings", {
        request: { settings } satisfies SaveSettingsRequest,
      }),
  },
};

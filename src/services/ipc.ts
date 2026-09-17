import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AppError,
  Book,
  CancelResult,
  ContentWindow,
  ErrorCode,
  ImportStatus,
  ImportTask,
  ReaderLocator,
} from "../types/generated";

export interface ReaderService {
  startImport(path: string): Promise<ImportTask>;
  getImportStatus(operationId: string): Promise<ImportStatus>;
  cancelImport(operationId: string): Promise<CancelResult>;
  listBooks(): Promise<Book[]>;
  readContentWindow(
    bookId: string,
    locator: ReaderLocator | null,
    maxUnits: number,
  ): Promise<ContentWindow>;
  saveReaderLocator(locator: ReaderLocator): Promise<ReaderLocator>;
  getSavedReaderLocator(bookId: string): Promise<ReaderLocator | null>;
  onImportProgress(listener: (status: ImportStatus) => void): Promise<UnlistenFn>;
}

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

function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, args).catch((error: unknown) => {
    throw new ReaderServiceError(normalizeError(error));
  });
}

export const tauriReaderService: ReaderService = {
  startImport: (path) => invokeCommand<ImportTask>("start_import", { path }),
  getImportStatus: (operationId) =>
    invokeCommand<ImportStatus>("get_import_status", { operationId }),
  cancelImport: (operationId) =>
    invokeCommand<CancelResult>("cancel_import", { operationId }),
  listBooks: () => invokeCommand<Book[]>("list_books"),
  readContentWindow: (bookId, locator, maxUnits) =>
    invokeCommand<ContentWindow>("read_content_window", {
      bookId,
      locator,
      maxUnits,
    }),
  saveReaderLocator: (locator) =>
    invokeCommand<ReaderLocator>("save_reader_locator", { locator }),
  getSavedReaderLocator: (bookId) =>
    invokeCommand<ReaderLocator | null>("get_saved_reader_locator", { bookId }),
  onImportProgress: (listener) =>
    listen<ImportStatus>("import-progress", (event) => listener(event.payload)).catch(
      (error: unknown) => {
        throw new ReaderServiceError(normalizeError(error));
      },
    ),
};

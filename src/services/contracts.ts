import type {
  CancelResult,
  ContentWindow,
  ImportStatus,
  ImportTask,
  LibraryBook,
  ReaderLocator,
  ReaderPreferences,
  ReadContentRequest,
  TxtEncodingInfo,
  TxtEncodingRequest,
  TxtSourceRequest,
  TocEntry,
  Bookmark,
  BookmarkRequest,
  BookmarkIdRequest,
  SearchRequest,
  SearchResponse,
  TxtDecodeStatus,
  TxtDecodeTask,
} from "../types/generated";

export type Unsubscribe = () => void;
export interface LibraryService {
  pickAndImportTxt(): Promise<ImportTask | null>;
  startImport(path: string): Promise<ImportTask>;
  getImportStatus(operationId: string): Promise<ImportStatus>;
  cancelImport(operationId: string): Promise<CancelResult>;
  listBooks(): Promise<LibraryBook[]>;
  onImportProgress(listener: (status: ImportStatus) => void): Promise<Unsubscribe>;
  getTxtEncoding(bookId: string): Promise<TxtEncodingInfo>;
  pickAndReassociateTxt(bookId: string): Promise<TxtEncodingInfo | null>;
  reassociateTxtSource(request: TxtSourceRequest): Promise<TxtEncodingInfo>;
  startTxtDecode(request: TxtEncodingRequest): Promise<TxtDecodeTask>;
  getTxtDecodeStatus(operationId: string): Promise<TxtDecodeStatus>;
  cancelTxtDecode(operationId: string): Promise<CancelResult>;
  onTxtDecodeProgress(listener: (status: TxtDecodeStatus) => void): Promise<Unsubscribe>;
}
export interface ReaderService {
  readContentWindow(request: ReadContentRequest): Promise<ContentWindow>;
  resolveLocator(bookId: string, progress: number): Promise<ReaderLocator>;
  saveReaderLocator(locator: ReaderLocator): Promise<ReaderLocator>;
  getSavedReaderLocator(bookId: string): Promise<ReaderLocator | null>;
  listToc(bookId: string): Promise<TocEntry[]>;
  listBookmarks(bookId: string): Promise<Bookmark[]>;
  addBookmark(request: BookmarkRequest): Promise<Bookmark>;
  deleteBookmark(request: BookmarkIdRequest): Promise<void>;
  search(request: SearchRequest): Promise<SearchResponse>;
  cancelSearch(operationId: string): Promise<CancelResult>;
}
export interface SettingsService {
  getSettings(): Promise<ReaderPreferences>;
  saveSettings(settings: ReaderPreferences): Promise<ReaderPreferences>;
}
export interface AppServices {
  library: LibraryService;
  reader: ReaderService;
  settings: SettingsService;
}

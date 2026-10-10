import type {
  Book,
  UpdateBookRequest,
  ShelfPreferences,
  CancelResult,
  ContentWindow,
  ImportStatus,
  ImportTask,
  LibraryBook,
  LibraryGroup,
  ReaderLocator,
  ReaderPreferences,
  ReadContentRequest,
  TxtEncodingInfo,
  TxtEncodingRequest,
  TxtSourceRequest,
  TocListing,
  BookInfo,
  BookTocSettings,
  Bookmark,
  BookmarkRequest,
  BookmarkIdRequest,
  SearchRequest,
  SearchResponse,
  TxtTocRule,
  TxtDecodeStatus,
  TxtDecodeTask,
  TxtEncoding,
  ResolveOffsetRequest,
} from "../types/generated";

export type Unsubscribe = () => void;
export interface LibraryService {
  pickAndImportTxt(encoding?: TxtEncoding): Promise<ImportTask | null>;
  startImport(path: string, encoding?: TxtEncoding): Promise<ImportTask>;
  getImportStatus(operationId: string): Promise<ImportStatus>;
  cancelImport(operationId: string): Promise<CancelResult>;
  listBooks(): Promise<LibraryBook[]>;
  listRemovedBooks(): Promise<LibraryBook[]>;
  updateBook(request: UpdateBookRequest): Promise<Book>;
  removeBook(bookId: string): Promise<void>;
  restoreBook(bookId: string): Promise<void>;
  listGroups(): Promise<LibraryGroup[]>;
  createGroup(name: string): Promise<LibraryGroup>;
  renameGroup(id: string, name: string): Promise<LibraryGroup>;
  deleteGroup(id: string): Promise<void>;
  setBookGroups(bookId: string, groupIds: string[]): Promise<void>;
  onImportProgress(listener: (status: ImportStatus) => void): Promise<Unsubscribe>;
  getTxtEncoding(bookId: string): Promise<TxtEncodingInfo>;
  pickAndReassociateTxt(bookId: string): Promise<TxtEncodingInfo | null>;
  reassociateTxtSource(request: TxtSourceRequest): Promise<TxtEncodingInfo>;
  startTxtDecode(request: TxtEncodingRequest): Promise<TxtDecodeTask>;
  getTxtDecodeStatus(operationId: string): Promise<TxtDecodeStatus>;
  cancelTxtDecode(operationId: string): Promise<CancelResult>;
  onTxtDecodeProgress(listener: (status: TxtDecodeStatus) => void): Promise<Unsubscribe>;
  getBookInfo(bookId: string): Promise<BookInfo>;
}
export interface ReaderService {
  readContentWindow(request: ReadContentRequest): Promise<ContentWindow>;
  resolveLocator(bookId: string, progress: number): Promise<ReaderLocator>;
  resolveOffset(request: ResolveOffsetRequest): Promise<ReaderLocator>;
  saveReaderLocator(locator: ReaderLocator): Promise<ReaderLocator>;
  getSavedReaderLocator(bookId: string): Promise<ReaderLocator | null>;
  listToc(bookId: string): Promise<TocListing>;
  /** Chapter rules shared by all books, ordered as automatic detection tries them. */
  listTxtTocRules(): Promise<TxtTocRule[]>;
  /** Adds a rule when `id` is empty; otherwise updates it. */
  saveTxtTocRule(rule: TxtTocRule): Promise<TxtTocRule>;
  deleteTxtTocRule(id: string): Promise<void>;
  orderTxtTocRules(ids: string[]): Promise<TxtTocRule[]>;
  /** Imports a Legado or GripRead rule export; returns the rules added. */
  importTxtTocRules(json: string): Promise<TxtTocRule[]>;
  exportTxtTocRules(): Promise<string>;
  testTxtTocRule(pattern: string, sample: string): Promise<string[]>;
  saveBookTocSettings(bookId: string, settings: BookTocSettings): Promise<BookTocSettings>;
  listBookmarks(bookId: string): Promise<Bookmark[]>;
  addBookmark(request: BookmarkRequest): Promise<Bookmark>;
  deleteBookmark(request: BookmarkIdRequest): Promise<void>;
  search(request: SearchRequest): Promise<SearchResponse>;
  cancelSearch(operationId: string): Promise<CancelResult>;
}
export interface SettingsService {
  getShelfPreferences(): Promise<ShelfPreferences>;
  saveShelfPreferences(preferences: ShelfPreferences): Promise<ShelfPreferences>;
  getSettings(): Promise<ReaderPreferences>;
  saveSettings(settings: ReaderPreferences): Promise<ReaderPreferences>;
}
export interface AppServices {
  library: LibraryService;
  reader: ReaderService;
  settings: SettingsService;
}

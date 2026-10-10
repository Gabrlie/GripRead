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
  TocEntry,
  Bookmark,
  BookmarkRequest,
  BookmarkIdRequest,
  SearchRequest,
  SearchResponse,
  PreviewTocRuleRequest,
  SaveTocRuleRequest,
  TxtTocRule,
  TxtTocRulePreview,
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
}
export interface ReaderService {
  readContentWindow(request: ReadContentRequest): Promise<ContentWindow>;
  resolveLocator(bookId: string, progress: number): Promise<ReaderLocator>;
  resolveOffset(request: ResolveOffsetRequest): Promise<ReaderLocator>;
  saveReaderLocator(locator: ReaderLocator): Promise<ReaderLocator>;
  getSavedReaderLocator(bookId: string): Promise<ReaderLocator | null>;
  listToc(bookId: string): Promise<TocEntry[]>;
  getTocRule(bookId: string): Promise<TxtTocRule>;
  previewTocRule(request: PreviewTocRuleRequest): Promise<TxtTocRulePreview>;
  saveTocRule(request: SaveTocRuleRequest): Promise<TxtTocRule>;
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

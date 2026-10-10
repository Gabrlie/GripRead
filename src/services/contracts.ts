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
  ReaderAsset,
  TxtDecodeStatus,
  TxtDecodeTask,
  TxtEncoding,
  ResolveOffsetRequest,
  ShelfPlacement,
  ReadingStats,
  PickedFile,
  ReplaceRule,
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
  /** Moves a book to automatic grouping, a reading state, or one user group. */
  moveBook(bookId: string, placement: ShelfPlacement): Promise<void>;
  /** Picks TXT files (several at once); an empty list when cancelled. */
  pickTxtFiles(): Promise<string[]>;
  /** Picks a folder and lists the TXT files in it; an empty list when cancelled. */
  pickTxtFolder(): Promise<PickedFile[]>;
  /** Picks an image as the book's cover; `false` when cancelled. */
  pickBookCover(bookId: string): Promise<boolean>;
  clearBookCover(bookId: string): Promise<void>;
  /** Bytes of a managed image or font asset. */
  readAsset(id: string): Promise<ArrayBuffer>;
  /** Adds reading time to a local calendar day (`YYYY-MM-DD`). */
  addReadingTime(bookId: string, day: string, seconds: number): Promise<void>;
  readingStats(today: string): Promise<ReadingStats>;
  onImportProgress(listener: (status: ImportStatus) => void): Promise<Unsubscribe>;
  getTxtEncoding(bookId: string): Promise<TxtEncodingInfo>;
  pickAndReassociateTxt(bookId: string): Promise<TxtEncodingInfo | null>;
  reassociateTxtSource(request: TxtSourceRequest): Promise<TxtEncodingInfo>;
  startTxtDecode(request: TxtEncodingRequest): Promise<TxtDecodeTask>;
  getTxtDecodeStatus(operationId: string): Promise<TxtDecodeStatus>;
  cancelTxtDecode(operationId: string): Promise<CancelResult>;
  onTxtDecodeProgress(listener: (status: TxtDecodeStatus) => void): Promise<Unsubscribe>;
  getBookInfo(bookId: string): Promise<BookInfo>;
  /**
   * Re-derives the book's text when its replace rules or Chinese conversion
   * changed; `null` when the text is already current.
   */
  ensureTextTransforms(bookId: string): Promise<TxtDecodeTask | null>;
  setBookReplaceRules(bookId: string, enabled: boolean): Promise<void>;
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
  updateBookmarkNote(bookmarkId: string, note: string): Promise<void>;
  search(request: SearchRequest): Promise<SearchResponse>;
  /** Legado replace rules shared by all books, in application order. */
  listReplaceRules(): Promise<ReplaceRule[]>;
  /** Adds a rule when `id` is empty; otherwise updates it. */
  saveReplaceRule(rule: ReplaceRule): Promise<ReplaceRule>;
  deleteReplaceRules(ids: string[]): Promise<void>;
  orderReplaceRules(ids: string[]): Promise<ReplaceRule[]>;
  importReplaceRules(json: string): Promise<ReplaceRule[]>;
  exportReplaceRules(): Promise<string>;
  testReplaceRule(rule: ReplaceRule, sample: string): Promise<string>;
  cancelSearch(operationId: string): Promise<CancelResult>;
}
export interface SettingsService {
  getShelfPreferences(): Promise<ShelfPreferences>;
  saveShelfPreferences(preferences: ShelfPreferences): Promise<ShelfPreferences>;
  getSettings(): Promise<ReaderPreferences>;
  saveSettings(settings: ReaderPreferences): Promise<ReaderPreferences>;
  /** Picks a font file and copies it into managed assets; `null` when cancelled. */
  pickAndImportFont(): Promise<ReaderAsset | null>;
  listFonts(): Promise<ReaderAsset[]>;
  /** Picks an image for a reading style background; `null` when cancelled. */
  pickBackgroundImage(): Promise<ReaderAsset | null>;
  readFont(id: string): Promise<ArrayBuffer>;
  /** Also clears the font from saved preferences when it was selected. */
  deleteFont(id: string): Promise<void>;
}
export interface AppServices {
  library: LibraryService;
  reader: ReaderService;
  settings: SettingsService;
}

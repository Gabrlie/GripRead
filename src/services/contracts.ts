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
  WebDavSettings,
  SaveWebDavRequest,
  RemoteBackup,
  BackupSource,
  BackupPreview,
  RestoreReport,
  CloudBook,
  CloudUploadReport,
  WebDavCheck,
  ProgressPrompt,
  BookSourceSummary,
  BookSourceDetail,
  SourceImportPreview,
  ImportSourcesRequest,
  SourceSwitch,
  SourceLoginForm,
  SourceLoginRequest,
  SourceScriptReport,
  DebugSourceRequest,
  SourceDebugEvent,
  CheckSourcesRequest,
  SourceCheckEvent,
  SearchOnlineRequest,
  OnlineSearchEvent,
  ExploreKind,
  OnlineBook,
  OnlineChapter,
  OnlineContent,
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
  /** Moves a book to the 回收站. */
  removeBook(bookId: string): Promise<void>;
  /** Deletes a book from the app; `cloud` also deletes its cloud bookshelf copy. */
  deleteBook(bookId: string, cloud: boolean): Promise<void>;
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
/** WebDAV backups and the cloud bookshelf (Sync specification). */
export interface SyncService {
  getWebDav(): Promise<WebDavSettings>;
  saveWebDav(request: SaveWebDavRequest): Promise<WebDavSettings>;
  /** Checks an address and account and measures its latency; `password: null` uses the saved one. */
  testWebDav(request: SaveWebDavRequest): Promise<WebDavCheck>;
  /** Picks the local backup folder; `clear` removes it. Unchanged when cancelled. */
  setBackupFolder(clear?: boolean): Promise<WebDavSettings>;
  backupNow(): Promise<RemoteBackup>;
  /** The daily automatic backup; `null` when it is not due or not enabled. */
  runAutomaticBackup(): Promise<RemoteBackup | null>;
  listBackups(): Promise<RemoteBackup[]>;
  deleteBackup(name: string): Promise<void>;
  listRecoveryPoints(): Promise<string[]>;
  /** Picks a backup file; `null` when cancelled. */
  pickBackupFile(): Promise<BackupSource | null>;
  previewBackup(source: BackupSource): Promise<BackupPreview>;
  /** Writes a local recovery point, then merges the backup into the library. */
  restoreBackup(source: BackupSource): Promise<RestoreReport>;
  /** Saves the current records to a file the reader picks; `false` when cancelled. */
  exportBackupFile(): Promise<boolean>;
  listCloudBooks(): Promise<CloudBook[]>;
  /** Uploads the original files of these books (every shelf book when empty). */
  uploadBooks(bookIds: string[]): Promise<CloudUploadReport>;
  /** Downloads a cloud book completely, for the ordinary import. */
  downloadCloudBook(name: string): Promise<PickedFile>;
  deleteCloudBook(name: string): Promise<void>;
  /** Uploads the book's saved position when progress sync is on; `true` when uploaded. */
  uploadProgress(bookId: string, chapterTitle: string): Promise<boolean>;
  /** Another device's position for the book that has not been answered yet. */
  fetchProgress(bookId: string): Promise<ProgressPrompt | null>;
  acknowledgeProgress(bookId: string, deviceId: string, revision: number): Promise<void>;
}
/** Legado book sources: management, login, debugging, and checks (Sources specification). */
export interface SourceService {
  listSources(): Promise<BookSourceSummary[]>;
  getSource(url: string): Promise<BookSourceDetail>;
  /** What importing this JSON would add or update; nothing is saved. */
  previewImport(json: string): Promise<SourceImportPreview>;
  importSources(request: ImportSourcesRequest): Promise<BookSourceSummary[]>;
  /** Downloads source JSON from an address (网络导入). */
  fetchText(url: string): Promise<string>;
  /** Picks a source file and reads it; `null` when cancelled. */
  pickSourceFile(): Promise<string | null>;
  /** Saves an edited source; `previousUrl` is its address before editing. */
  saveSource(json: string, previousUrl?: string | null): Promise<BookSourceSummary>;
  deleteSources(urls: string[]): Promise<void>;
  setSwitch(urls: string[], which: SourceSwitch, on: boolean): Promise<void>;
  changeGroup(urls: string[], group: string, add: boolean): Promise<void>;
  moveSources(urls: string[], top: boolean): Promise<void>;
  /** The sources as Legado export JSON; every source when `urls` is empty. */
  exportSources(urls: string[]): Promise<string>;
  /** Saves sources to a file the reader picks; `false` when cancelled. */
  exportSourcesFile(urls: string[]): Promise<boolean>;
  getLoginForm(url: string): Promise<SourceLoginForm>;
  login(request: SourceLoginRequest): Promise<SourceScriptReport>;
  getVariable(url: string): Promise<string | null>;
  setVariable(url: string, value: string | null): Promise<void>;
  clearCookies(url: string): Promise<void>;
  /** Starts a debug run; lines arrive through `onDebug`. */
  debug(request: DebugSourceRequest): Promise<void>;
  onDebug(listener: (event: SourceDebugEvent) => void): Promise<Unsubscribe>;
  /** Starts checking sources; progress arrives through `onCheck`. */
  check(request: CheckSourcesRequest): Promise<void>;
  onCheck(listener: (event: SourceCheckEvent) => void): Promise<Unsubscribe>;
  cancel(operationId: string): Promise<CancelResult>;
  /** Starts searching sources; merged results arrive through `onSearch`. Cancel with `cancel`. */
  search(request: SearchOnlineRequest): Promise<void>;
  onSearch(listener: (event: OnlineSearchEvent) => void): Promise<Unsubscribe>;
  /** A source's 发现 categories; `refresh` runs its script again. */
  exploreKinds(sourceUrl: string, refresh?: boolean): Promise<ExploreKind[]>;
  exploreBooks(sourceUrl: string, url: string, page: number): Promise<OnlineBook[]>;
  /** The book with its details page read. */
  bookInfo(book: OnlineBook): Promise<OnlineBook>;
  chapters(book: OnlineBook): Promise<OnlineChapter[]>;
  chapterContent(
    book: OnlineBook,
    chapter: OnlineChapter,
    nextChapterUrl: string | null,
  ): Promise<OnlineContent>;
  /** A cover image fetched with the source's headers. */
  cover(sourceUrl: string, url: string): Promise<ArrayBuffer>;
}
export interface AppServices {
  library: LibraryService;
  reader: ReaderService;
  settings: SettingsService;
  sync: SyncService;
  sources: SourceService;
}

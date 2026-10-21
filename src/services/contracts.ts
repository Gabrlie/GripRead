import type {
  SaveGroupPrivacyRequest,
  Article,
  ArticlePage,
  ArticleQuery,
  Feed,
  FeedAccount,
  FeedFilter,
  FeedFilterTest,
  FeedPreview,
  FeedSearchResult,
  FeedGroup,
  ArticleCursor,
  UpdateFeedRequest,
  OpmlImportReport,
  RssRefreshEvent,
  RssSettings,
  SaveFeedAccountRequest,
} from "../types/generated";
import type {
  BookImage,
  BookTranslation,
  BookTranslationEvent,
  ChapterTranslationEvent,
  TranslationEngine,
  TranslationSettings,
  InstallOutcome,
  SaveUpdateSettingsRequest,
  UpdateCheck,
  UpdateProgress,
  UpdateSettings,
} from "../types/generated";
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
  ComicChapter,
  ReaderPreferences,
  ReadContentRequest,
  TxtEncodingInfo,
  TxtEncodingRequest,
  TxtSourceRequest,
  TocListing,
  TocSuggestion,
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
  ReplaceRuleImportPreview,
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
  SourceNotice,
  SourceSubscription,
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
  AddOnlineBookRequest,
  UpdateOnlineTocRequest,
  OnlineTocEvent,
  ChangeOnlineSourceRequest,
  ChangeOnlineSourceResult,
  DataUsage,
  DownloadJob,
  NetworkCheck,
  NetworkSettings,
  NetworkState,
  SyncServerStatus,
  ConnectSyncServerRequest,
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
  /** A group with a password needs it. */
  deleteGroup(id: string, password?: string): Promise<void>;
  saveGroupPrivacy(request: SaveGroupPrivacyRequest): Promise<LibraryGroup>;
  /** Rejects a wrong password. */
  unlockGroup(id: string, password: string): Promise<void>;
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
  /** 删除记录: the book's reading time no longer counts anywhere. */
  deleteReadingRecord(bookId: string): Promise<void>;
  onImportProgress(listener: (status: ImportStatus) => void): Promise<Unsubscribe>;
  getTxtEncoding(bookId: string): Promise<TxtEncodingInfo>;
  pickAndReassociateTxt(bookId: string): Promise<TxtEncodingInfo | null>;
  reassociateTxtSource(request: TxtSourceRequest): Promise<TxtEncodingInfo>;
  startTxtDecode(request: TxtEncodingRequest): Promise<TxtDecodeTask>;
  getTxtDecodeStatus(operationId: string): Promise<TxtDecodeStatus>;
  cancelTxtDecode(operationId: string): Promise<CancelResult>;
  onTxtDecodeProgress(listener: (status: TxtDecodeStatus) => void): Promise<Unsubscribe>;
  getBookInfo(bookId: string): Promise<BookInfo>;
  /** An EPUB's image sizes by index (empty for other books). */
  listBookImages(bookId: string): Promise<BookImage[]>;
  readBookImage(bookId: string, index: number): Promise<ArrayBuffer>;
  /** A comic chapter's pages, by its place in the contents. */
  getComicChapter(bookId: string, index: number): Promise<ComicChapter>;
  /** One page of a comic chapter, fetched through its source when not kept. */
  readComicPage(bookId: string, chapter: number, page: number): Promise<ArrayBuffer>;
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
  /** `rebuild` finds a local book's chapters again instead of reading the kept ones. */
  listToc(bookId: string, options?: { rebuild?: boolean }): Promise<TocListing>;
  /** The one-time question about the book's contents, if there is one. */
  tocSuggestion(bookId: string): Promise<TocSuggestion | null>;
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
  /** What importing `json` would do, rule by rule. */
  previewReplaceRules(json: string): Promise<ReplaceRuleImportPreview>;
  /** `chosen` lists positions in the preview; all rules when absent. */
  importReplaceRules(json: string, chosen?: number[]): Promise<ReplaceRule[]>;
  exportReplaceRules(): Promise<string>;
  /** 网络导入 for rules (replace or chapter rules): the text at an address. */
  fetchRuleText(url: string): Promise<string>;
  /** 本地导入 for rules: a picked JSON or text file's text, `null` when none was picked. */
  pickRuleFile(): Promise<string | null>;
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
  /** 网络设置: DoH, the app's proxy, and request limits (kept on the device). */
  getNetwork(): Promise<NetworkSettings>;
  saveNetwork(settings: NetworkSettings): Promise<NetworkSettings>;
  /** 测试 with the settings as entered: `doh` resolves a host, `proxy` fetches a page. */
  checkNetwork(settings: NetworkSettings, kind: "doh" | "proxy"): Promise<NetworkCheck>;
  /** The device's own proxy, checked again. */
  networkState(): Promise<NetworkState>;
  /** The device's network or proxy changed (Android). */
  onNetworkChange(listener: () => void): Promise<Unsubscribe>;
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
  deleteRecoveryPoint(name: string): Promise<void>;
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
  acknowledgeProgress(
    bookId: string,
    deviceId: string,
    revision: number,
    locator?: ReaderLocator,
  ): Promise<void>;
  /** 设置 › 服务器: this device's connection to the GripRead server. */
  getServer(): Promise<SyncServerStatus>;
  /** Signs in with the server's password; the first sync starts at once. */
  connectServer(request: ConnectSyncServerRequest): Promise<SyncServerStatus>;
  disconnectServer(): Promise<SyncServerStatus>;
  /** Drops the sign-in kept after disconnecting. */
  forgetServerLogin(): Promise<SyncServerStatus>;
  syncServerNow(): Promise<void>;
  setServerAutoDownload(on: boolean): Promise<SyncServerStatus>;
  /** 通过服务器更新书籍: off makes 更新目录 fetch contents on this device. */
  setServerUpdateViaServer(on: boolean): Promise<SyncServerStatus>;
  /** The book open in the reader, which is told of other devices' positions. */
  setSyncOpenBook(bookId: string | null): Promise<void>;
  onServerStatus(listener: (status: SyncServerStatus) => void): Promise<Unsubscribe>;
  /** Records from the server changed the library. */
  onSyncApplied(listener: () => void): Promise<Unsubscribe>;
  /** Another device's position arrived for this open book. */
  onSyncProgress(listener: (bookId: string) => void): Promise<Unsubscribe>;
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
  /** 通过服务器访问 for sources, on this device; used while connected to a server. */
  setViaServer(urls: string[], on: boolean): Promise<void>;
  /** Starts a debug run; lines arrive through `onDebug`. */
  debug(request: DebugSourceRequest): Promise<void>;
  onDebug(listener: (event: SourceDebugEvent) => void): Promise<Unsubscribe>;
  /** 书源订阅, kept on this device. */
  listSubscriptions(): Promise<SourceSubscription[]>;
  /** Adds one (empty id) or changes one; answers the list. */
  saveSubscription(subscription: SourceSubscription): Promise<SourceSubscription[]>;
  deleteSubscription(id: string): Promise<SourceSubscription[]>;
  /** Notes that an update imported `count` sources. */
  subscriptionImported(id: string, count: number): Promise<SourceSubscription[]>;
  /** Notices about sources the reader should hear of (a relay that fell back). */
  onNotice(listener: (event: SourceNotice) => void): Promise<Unsubscribe>;
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
  /** The book with its details page read; a copy kept within the hour unless `refresh`. */
  bookInfo(book: OnlineBook, refresh?: boolean): Promise<OnlineBook>;
  chapters(book: OnlineBook, refresh?: boolean): Promise<OnlineChapter[]>;
  /** 数据管理: the data folder by part, and the shelf's online book caches. */
  dataUsage(): Promise<DataUsage>;
  /** 清理所选: clears the chosen clearable parts. */
  clearData(parts: string[]): Promise<void>;
  /** 转为本地书籍: a fully cached online book becomes a local TXT book. */
  convertToLocal(bookId: string): Promise<LibraryBook>;
  /** Saves a source's cover image as the book's own cover. */
  setCoverFromSource(bookId: string, sourceUrl: string, url: string): Promise<void>;
  chapterContent(
    book: OnlineBook,
    chapter: OnlineChapter,
    nextChapterUrl: string | null,
  ): Promise<OnlineContent>;
  /** A cover image fetched with the source's headers. */
  cover(sourceUrl: string, url: string): Promise<ArrayBuffer>;
  /** Keeps an online book with its contents; `onShelf` false only opens it for reading. */
  addOnlineBook(request: AddOnlineBookRequest): Promise<LibraryBook>;
  getLibraryBook(bookId: string): Promise<LibraryBook>;
  /** 换源: the kept book takes these details and contents from another source. */
  changeSource(request: ChangeOnlineSourceRequest): Promise<ChangeOnlineSourceResult>;
  /** The shelf's online book with this name and author, from any source. */
  findOnlineBook(name: string, author: string): Promise<LibraryBook | null>;
  setOnShelf(bookId: string, on: boolean): Promise<void>;
  setCanUpdate(bookId: string, on: boolean): Promise<void>;
  /** Drops a book read from search that was not added; returns whether it was dropped. */
  leaveOnlineBook(bookId: string): Promise<boolean>;
  listOnlineChapters(bookId: string): Promise<OnlineChapter[]>;
  clearOnlineCache(bookId: string): Promise<void>;
  /** 更新目录 for these books, or every shelf book that allows it when empty. */
  updateToc(request: UpdateOnlineTocRequest): Promise<void>;
  onTocUpdate(listener: (event: OnlineTocEvent) => void): Promise<Unsubscribe>;
  /** 下载管理: adds a chapter range `[start, end)` of an online book to the queue. */
  enqueueDownload(bookId: string, start: number, end: number): Promise<DownloadJob>;
  listDownloads(): Promise<DownloadJob[]>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  pauseAllDownloads(): Promise<void>;
  clearFinishedDownloads(): Promise<void>;
  /** Every job after each change. */
  onDownloads(listener: (jobs: DownloadJob[]) => void): Promise<Unsubscribe>;
  /** The Android notification's 停止. */
  onDownloadStop(listener: () => void): Promise<Unsubscribe>;
}
/** 检查更新: GitHub releases, through the connected server when there is one. */
export interface UpdateService {
  getSettings(): Promise<UpdateSettings>;
  saveSettings(request: SaveUpdateSettingsRequest): Promise<UpdateSettings>;
  /** The channel's newest release against the running version, and recent notes. */
  /** `automatic` (自动检查更新) alone counts toward the daily check. */
  check(current: string, automatic?: boolean): Promise<UpdateCheck>;
  /** Downloads and installs `version`; progress comes through `onProgress`. */
  install(operationId: string, version: string): Promise<InstallOutcome>;
  cancel(operationId: string): Promise<CancelResult>;
  onProgress(listener: (progress: UpdateProgress) => void): Promise<Unsubscribe>;
}
/** 翻译: engines and settings kept on this device, and each book's translation. */
export interface TranslationService {
  getSettings(): Promise<TranslationSettings>;
  saveSettings(settings: TranslationSettings): Promise<TranslationSettings>;
  /** Translates a sample sentence with `engine`; resolves with the translation. */
  testEngine(engine: TranslationEngine, target: string): Promise<string>;
  /** The book's language (detected the first time) and its translation. */
  getBook(bookId: string): Promise<BookTranslation>;
  /** `null` turns translation off. */
  setBook(bookId: string, translateTo: string | null): Promise<BookTranslation>;
  /** `null` detects the language again. */
  setLanguage(bookId: string, language: string | null): Promise<BookTranslation>;
  /**
   * Translates a local book in the background, from the reader's place on or
   * the whole book; progress arrives through `onBookProgress`.
   */
  translateBook(bookId: string, whole: boolean): Promise<void>;
  stopBook(bookId: string): Promise<void>;
  onBookProgress(listener: (event: BookTranslationEvent) => void): Promise<() => void>;
  /** Short texts (titles, introductions) translated; `null` when kept as written. */
  translateTexts(texts: string[]): Promise<(string | null)[]>;
  /** Each text's language code, `null` where it cannot be told. */
  detectLanguages(texts: string[]): Promise<(string | null)[]>;
  /** An online chapter being translated as it opens. */
  onChapterProgress(listener: (event: ChapterTranslationEvent) => void): Promise<() => void>;
}

/** An article's marks; absent ones stay. 保持未读 also marks it unread. */
export interface ArticleMarks {
  read?: boolean;
  starred?: boolean;
  keepUnread?: boolean;
}

/** 订阅: RSS/Atom subscriptions, their articles, and article state. */
export interface FeedService {
  listFeeds(): Promise<Feed[]>;
  /**
   * 搜索订阅: words in Feedly's directory; an address as a feed, the feeds
   * its page names, or RSSHub routes for it.
   */
  search(query: string): Promise<FeedSearchResult[]>;
  /** A feed's newest articles, without subscribing. */
  preview(url: string): Promise<FeedPreview>;
  /** Subscribes here, or on a 订阅账号 (`account`). */
  addFeed(
    url: string,
    title: string | null,
    group: string | null,
    account?: string | null,
  ): Promise<Feed>;
  /** Changes a feed (a new address must be a feed); answers it as it now is. */
  updateFeed(request: UpdateFeedRequest): Promise<Feed>;
  removeFeeds(urls: string[]): Promise<void>;
  /** The groups in order, those only feeds name included. */
  listGroups(): Promise<FeedGroup[]>;
  /** Puts the groups in this order, creating the new ones. */
  saveGroups(names: string[]): Promise<void>;
  /** A group of the device's own, or of `account` (renamed on it). */
  renameGroup(name: string, newName: string, account?: string | null): Promise<void>;
  /** Its feeds become ungrouped, or are unsubscribed (on the account too). */
  removeGroup(name: string, unsubscribe: boolean, account?: string | null): Promise<void>;
  /**
   * Refreshes the enabled feeds and syncs the 订阅账号 (all when neither is
   * named; with `due`, those whose interval has passed); progress comes
   * through `onRefresh`.
   */
  refresh(operationId: string, urls: string[], due?: boolean, accounts?: string[]): Promise<void>;
  onRefresh(listener: (event: RssRefreshEvent) => void): Promise<Unsubscribe>;
  listArticles(query: ArticleQuery): Promise<ArticlePage>;
  getArticle(id: string): Promise<Article>;
  /** 全文: the page's main text, kept with the article. */
  fetchFullText(id: string): Promise<string>;
  setArticleState(ids: string[], state: ArticleMarks): Promise<void>;
  markAllRead(scope: {
    feed?: string | null;
    group?: string | null;
    account?: string | null;
  }): Promise<number>;
  /** 以上/以下标为已读: the list's articles newer or older than `from`, and it. */
  markReadRange(query: ArticleQuery, from: ArticleCursor, newer: boolean): Promise<number>;
  image(url: string, referer: string | null): Promise<ArrayBuffer>;
  /** Picks an OPML file and subscribes to its feeds; `null` when cancelled. */
  importOpml(): Promise<OpmlImportReport | null>;
  /** Saves the subscriptions as OPML; `false` when cancelled. */
  exportOpml(): Promise<boolean>;
  getSettings(): Promise<RssSettings>;
  saveSettings(settings: RssSettings): Promise<RssSettings>;
  /** 过滤规则, in order. */
  listFilters(): Promise<FeedFilter[]>;
  /**
   * Saves a rule (a new one when its id is empty); with `purge`, stored
   * articles it would have kept out go too (starred ones stay).
   */
  saveFilter(filter: FeedFilter, purge: boolean): Promise<FeedFilter>;
  removeFilter(id: string): Promise<void>;
  /** What a rule would keep out of the newest stored articles. */
  testFilter(filter: FeedFilter): Promise<FeedFilterTest>;
  /** 订阅账号, in order. */
  listAccounts(): Promise<FeedAccount[]>;
  /** Signs in, then adds or changes the account. */
  saveAccount(request: SaveFeedAccountRequest): Promise<FeedAccount>;
  /** Removes an account and what it brought from this device. */
  removeAccount(id: string): Promise<void>;
}
export interface AppServices {
  library: LibraryService;
  reader: ReaderService;
  settings: SettingsService;
  sync: SyncService;
  sources: SourceService;
  updates: UpdateService;
  translation: TranslationService;
  feeds: FeedService;
}

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use uuid::Uuid;

use crate::api::Events;
use crate::error::{AppError, ErrorCode};
use crate::models::{
    BookInfo, BookRequest, BookTocSettings, Bookmark, BookmarkIdRequest, BookmarkRequest,
    CancelResult, ContentWindow, CreateGroupRequest, GroupRequest, ImportOperationRequest,
    ImportPhase, ImportResult, ImportStatus, ImportTask, ImportTxtTocRulesRequest, LibraryBook,
    LibraryGroup, OrderTxtTocRulesRequest, ReadContentRequest, ReaderLocator, ReaderPreferences,
    RenameGroupRequest, ResolveLocatorRequest, ResolveOffsetRequest, SaveBookTocSettingsRequest,
    SaveLocatorRequest, SaveSettingsRequest, SaveTxtTocRuleRequest, SearchRequest, SearchResponse,
    StartImportRequest, TestTxtTocRuleRequest, TocListing, TxtDecodeStatus, TxtDecodeTask,
    TxtEncoding, TxtEncodingInfo, TxtEncodingRequest, TxtSourceRequest, TxtTocRule,
    TxtTocRuleIdRequest,
};
use crate::platform::Platform;
use crate::storage::{
    before_import_commit, build_toc_from_context, duplicate_validation_retry,
    prepare_import_for_target, read_content_window_from_context, resolve_locator_from_context,
    resolve_offset_from_context, validate_content_locator, validate_import_target,
    verify_content_context, verify_prepared_txt_decode_source, Storage,
};
use crate::txt_toc::TocBuild;

/// Everything the commands share for the life of the app: storage, the
/// operations in flight, the download queue, and the shell's events and
/// platform.
pub struct AppState {
    pub storage: Arc<Mutex<Storage>>,
    pub data_root: PathBuf,
    imports: Arc<Mutex<HashMap<String, ImportOperation>>>,
    txt_decodes: Arc<Mutex<HashMap<String, TxtDecodeOperation>>>,
    searches: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    toc_builds: Arc<Mutex<HashMap<TocBuildKey, Arc<TocBuildFlight>>>>,
    pub operations: crate::source_commands::SourceOperations,
    pub pages: Arc<crate::online_commands::OnlinePages>,
    pub events: Arc<dyn Events>,
    pub platform: Arc<dyn Platform>,
    downloads: crate::downloads::Downloads,
    pub sync: crate::sync_client::SyncClient,
}

struct ImportOperation {
    cancel: Arc<AtomicBool>,
    status: ImportStatus,
}

struct TxtDecodeOperation {
    cancel: Arc<AtomicBool>,
    status: TxtDecodeStatus,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct TocBuildKey {
    book_id: String,
    content_version: String,
    rule_identity: String,
    rule_revision: i64,
}

struct TocBuildFlight {
    result: Mutex<Option<Result<TocBuild, AppError>>>,
    ready: Condvar,
}

impl TocBuildFlight {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    fn wait(&self) -> Result<TocBuild, AppError> {
        let mut result = self
            .result
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "TOC build result lock is poisoned"))?;
        loop {
            if let Some(result) = result.as_ref() {
                return result.clone();
            }
            result = self.ready.wait(result).map_err(|_| {
                AppError::new(ErrorCode::Database, "TOC build result lock is poisoned")
            })?;
        }
    }

    fn complete(&self, result: Result<TocBuild, AppError>) {
        let mut stored = self
            .result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *stored = Some(result);
        self.ready.notify_all();
    }
}

fn acquire_toc_build(
    builds: &Mutex<HashMap<TocBuildKey, Arc<TocBuildFlight>>>,
    key: TocBuildKey,
) -> Result<(Arc<TocBuildFlight>, bool), AppError> {
    let mut builds = builds
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "TOC build registry is poisoned"))?;
    if let Some(flight) = builds.get(&key) {
        return Ok((Arc::clone(flight), false));
    }
    let flight = Arc::new(TocBuildFlight::new());
    builds.insert(key, Arc::clone(&flight));
    Ok((flight, true))
}

fn release_toc_build(
    builds: &Mutex<HashMap<TocBuildKey, Arc<TocBuildFlight>>>,
    key: &TocBuildKey,
    flight: &Arc<TocBuildFlight>,
) {
    let mut builds = builds
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if builds
        .get(key)
        .is_some_and(|registered| Arc::ptr_eq(registered, flight))
    {
        builds.remove(key);
    }
}

impl AppState {
    /// Opens the data folder and starts the app's services: the log, network
    /// settings, and the download queue, which reports through `events` and
    /// the platform's notification.
    pub fn open(
        data_dir: PathBuf,
        events: Arc<dyn Events>,
        platform: Arc<dyn Platform>,
    ) -> Result<Arc<Self>, AppError> {
        crate::app_log::init(&data_dir);
        crate::notify::set_events(events.clone());
        crate::log_keyed!(
            Info,
            "app",
            "started",
            format!("启动 GripRead {}", env!("CARGO_PKG_VERSION")),
            version = env!("CARGO_PKG_VERSION"),
        );
        let mut storage = Storage::open(&data_dir)?;
        match storage.purge_unshelved_online_books() {
            Ok(0) => {}
            Ok(count) => crate::log_keyed!(
                Info,
                "library",
                "purgedUnshelved",
                format!("清理了 {count} 本 30 天未打开、未加入书架的网络书籍"),
                count = count,
            ),
            Err(error) => crate::log_keyed!(
                Warn,
                "library",
                "purgeFailed",
                format!("清理未加入书架的书失败：{}", error.message),
                @error error,
            ),
        }
        // 退出时清理缓存: Android has no dependable exit, so the caches the
        // last session left are cleared as this one starts.
        if storage
            .get_settings()
            .is_ok_and(|settings| settings.clear_cache_on_exit == Some(true))
        {
            let parts: Vec<String> = crate::storage::DEFAULT_CLEARED
                .iter()
                .map(|part| part.to_string())
                .collect();
            if let Err(error) = storage.clear_data(&parts) {
                crate::log_keyed!(Warn, "library", "clearCacheFailed", format!("清理缓存失败：{}", error.message), @error error);
            }
        }
        let data_root = storage.root_path().to_path_buf();
        // Storage now holds the exclusive data lock, so no other process owns these copies.
        crate::documents::clear_staging(&data_root)?;
        let storage = Arc::new(Mutex::new(storage));
        if let Err(error) = crate::network::start(&data_root) {
            crate::log_keyed!(
                Warn,
                "network",
                "networkSettingsInvalid",
                format!("网络设置无效，已用默认：{}", error.message),
                @error error,
            );
        }
        let downloads = {
            let (events, platform) = (events.clone(), platform.clone());
            crate::downloads::Downloads::new(
                Arc::new(crate::downloads::LibraryChapters(storage.clone())),
                Arc::new(|| {
                    let limits = crate::network::limits();
                    (
                        usize::from(limits.download_books),
                        usize::from(limits.download_chapters),
                    )
                }),
                Arc::new(move |jobs: &[crate::models::DownloadJob]| {
                    if let Ok(payload) = serde_json::to_value(jobs) {
                        events.emit("download-progress", payload);
                    }
                    platform.downloads_changed(jobs);
                }),
                Some(data_root.join("downloads.json")),
            )
        };
        let sync =
            crate::sync_client::SyncClient::start(&data_root, storage.clone(), events.clone());
        // 通过服务器访问 sends a chosen source's requests through the server.
        {
            let client = sync.clone();
            crate::sources::http::set_relay(Some(Arc::new(
                move |hop: &crate::sources::http::Hop| client.relay_hop(hop),
            )));
        }
        // Online chapters come through the server while connected.
        if let Ok(mut guard) = storage.lock() {
            let client = sync.clone();
            guard.set_chapter_relay(crate::storage::ChapterRelay(Arc::new(
                move |key: &str, chapter: &crate::models::OnlineChapter| {
                    client.fetch_chapter(key, chapter)
                },
            )));
        }
        Ok(Arc::new(Self {
            sync,
            storage,
            data_root,
            imports: Arc::new(Mutex::new(HashMap::new())),
            txt_decodes: Arc::new(Mutex::new(HashMap::new())),
            searches: Arc::new(Mutex::new(HashMap::new())),
            toc_builds: Arc::new(Mutex::new(HashMap::new())),
            operations: Default::default(),
            pages: Default::default(),
            events,
            platform,
            downloads,
        }))
    }

    /// Sends `payload` to the page as `event`.
    pub fn emit<T: serde::Serialize>(&self, event: &str, payload: T) -> Result<(), AppError> {
        let payload = serde_json::to_value(payload)
            .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?;
        self.events.emit(event, payload);
        Ok(())
    }

    pub fn downloads(&self) -> &crate::downloads::Downloads {
        &self.downloads
    }
}

pub async fn start_import(
    state: &Arc<AppState>,
    request: StartImportRequest,
) -> Result<ImportTask, AppError> {
    let app = state.clone();
    if request.path.trim().is_empty() {
        return Err(AppError::invalid_argument("import path cannot be empty"));
    }
    let operation_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let initial_status = ImportStatus {
        operation_id: operation_id.clone(),
        phase: ImportPhase::Staging,
        bytes_read: 0,
        total_bytes: 0,
        result: None,
        error: None,
    };
    let imports = Arc::clone(&state.imports);
    imports
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "import state lock is poisoned"))?
        .insert(
            operation_id.clone(),
            ImportOperation {
                cancel: Arc::clone(&cancel),
                status: initial_status,
            },
        );

    // Only the immutable data-directory path is copied while holding the
    // storage mutex. Reading, decoding, hashing, and index construction all
    // happen in the blocking worker before the short commit lock.
    let data_root = state.data_root.clone();
    let storage = Arc::clone(&state.storage);
    let toc_builds = Arc::clone(&state.toc_builds);
    let toc_storage = Arc::clone(&state.storage);
    let worker_operation_id = operation_id.clone();
    let worker_imports = Arc::clone(&imports);
    let source = request.path;
    let requested_encoding = request.encoding.unwrap_or(TxtEncoding::Auto);
    let worker_app = app.clone();
    tokio::spawn(async move {
        let blocking_operation_id = worker_operation_id.clone();
        let blocking_imports = Arc::clone(&worker_imports);
        let blocking_app = worker_app.clone();
        let blocking = tokio::task::spawn_blocking(move || {
            // A staged document copy stays alive until this worker finishes,
            // because commit still derives the title from the source path.
            let (source, _staged) = crate::documents::resolve_source(
                &*blocking_app.platform,
                &data_root,
                &source,
                &blocking_operation_id,
                &cancel,
            )?;
            let mut prepared = Storage::prepare_import(
                &data_root,
                &source,
                &blocking_operation_id,
                requested_encoding,
                &cancel,
                |phase, bytes_read, total_bytes| {
                    publish_import_status(
                        &blocking_imports,
                        &blocking_app,
                        ImportStatus {
                            operation_id: blocking_operation_id.clone(),
                            phase,
                            bytes_read,
                            total_bytes,
                            result: None,
                            error: None,
                        },
                    );
                },
            )?;
            let result = (|| -> Result<ImportResult, AppError> {
                // A second importer can commit the same hash between the
                // metadata snapshot and the commit lock. Retry that one
                // narrow race after rehashing the managed target outside the
                // storage mutex; ordinary content changes remain failures.
                for attempt in 0..=1 {
                    let target = {
                        let guard = storage.lock().map_err(|_| {
                            AppError::new(ErrorCode::Database, "storage lock is poisoned")
                        })?;
                        guard.snapshot_import_target(&prepared.sha256, &prepared.source_sha256)?
                    };
                    if let Some(target) = target.as_ref() {
                        prepare_import_for_target(&data_root, &mut prepared, target, &cancel)?;
                    }
                    let validated_target = target
                        .as_ref()
                        .map(|target| validate_import_target(&data_root, target, &cancel))
                        .transpose()?;
                    // Test-only waiting and failure injection must happen
                    // before acquiring the shared storage mutex so cancel and
                    // read operations remain responsive while paused.
                    before_import_commit(&data_root, &cancel)?;
                    let mut guard = storage.lock().map_err(|_| {
                        AppError::new(ErrorCode::Database, "storage lock is poisoned")
                    })?;
                    match guard.commit_import(
                        prepared.clone(),
                        &cancel,
                        |_, _, _| {},
                        validated_target.as_ref(),
                    ) {
                        Err(error) if attempt == 0 && duplicate_validation_retry(&error) => {
                            continue;
                        }
                        Ok(imported) => {
                            // Backup records restored before the book was here.
                            if let Err(error) = guard.apply_pending_restore(&imported.book.id) {
                                eprintln!("Unable to apply restored records: {}", error.message);
                            }
                            if let Err(error) = guard.apply_epub_cover(&imported.book.id) {
                                crate::log_keyed!(
                                    Warn,
                                    "import",
                                    "epubCoverFailed",
                                    format!("EPUB 封面设置失败：{}", error.message),
                                    @error error,
                                );
                            }
                            return Ok(imported);
                        }
                        result => return result,
                    }
                }
                unreachable!("duplicate validation retry loop always returns")
            })();
            match result {
                Ok(imported) => Ok(imported),
                Err(error) => {
                    // Ordinary worker failures are cleaned immediately. If a
                    // file or SQLite cleanup step fails, cleanup_import leaves
                    // the durable journal in place for the next restart.
                    let cleanup = storage
                        .lock()
                        .map_err(|_| {
                            AppError::new(ErrorCode::Database, "storage lock is poisoned")
                        })?
                        .cleanup_import(&blocking_operation_id);
                    match cleanup {
                        Ok(()) => Err(error),
                        Err(cleanup_error) => Err(AppError::new(
                            error.code.clone(),
                            format!(
                                "{}; import cleanup failed: {}",
                                error.message, cleanup_error.message
                            ),
                        )),
                    }
                }
            }
        });
        let result = match blocking.await {
            Ok(result) => result,
            Err(error) => Err(AppError::new(
                ErrorCode::Io,
                format!("import worker stopped unexpectedly: {error}"),
            )),
        };
        match result {
            Ok(imported) => {
                let book_id = imported.book.id.clone();
                publish_import_status(
                    &worker_imports,
                    &worker_app,
                    completed_status(&worker_operation_id, imported),
                );
                // Build the directory after the shelf shows the book, so
                // opening it is immediate; an early open joins this build.
                // A failure leaves the book readable and is retried on open.
                let built = tokio::task::spawn_blocking(move || {
                    list_toc_current(&toc_storage, &toc_builds, &book_id)
                })
                .await;
                if let Ok(Err(error)) = built {
                    eprintln!("Directory build after import failed: {}", error.message);
                }
            }
            Err(error) if error.code == ErrorCode::ImportCancelled => publish_import_status(
                &worker_imports,
                &worker_app,
                terminal_status(
                    &worker_imports,
                    &worker_operation_id,
                    ImportPhase::Cancelled,
                    error,
                ),
            ),
            Err(error) => publish_import_status(
                &worker_imports,
                &worker_app,
                terminal_status(
                    &worker_imports,
                    &worker_operation_id,
                    ImportPhase::Failed,
                    error,
                ),
            ),
        }
    });

    Ok(ImportTask { operation_id })
}

pub async fn get_import_status(
    state: &Arc<AppState>,
    request: ImportOperationRequest,
) -> Result<ImportStatus, AppError> {
    let imports = Arc::clone(&state.imports);
    tokio::task::spawn_blocking(move || {
        imports
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "import state lock is poisoned"))?
            .get(&request.operation_id)
            .map(|operation| operation.status.clone())
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::OperationNotFound,
                    "import operation was not found",
                )
            })
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("status worker stopped: {error}")))?
}

pub async fn cancel_import(
    state: &Arc<AppState>,
    request: ImportOperationRequest,
) -> Result<CancelResult, AppError> {
    let imports = Arc::clone(&state.imports);
    tokio::task::spawn_blocking(move || {
        let imports = imports
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "import state lock is poisoned"))?;
        let operation = imports.get(&request.operation_id).ok_or_else(|| {
            AppError::new(
                ErrorCode::OperationNotFound,
                "import operation was not found",
            )
        })?;
        let terminal = matches!(
            operation.status.phase,
            ImportPhase::Completed | ImportPhase::Failed | ImportPhase::Cancelled
        );
        if !terminal {
            operation.cancel.store(true, Ordering::Release);
        }
        Ok(CancelResult {
            requested: !terminal,
        })
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("cancel worker stopped: {error}")))?
}

pub async fn list_books(state: &Arc<AppState>) -> Result<Vec<LibraryBook>, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        storage.list_library_books()
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("library worker stopped: {error}")))?
}

pub async fn list_groups(state: &Arc<AppState>) -> Result<Vec<LibraryGroup>, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .list_groups()
    })
    .await
    .map_err(|error| {
        AppError::new(
            ErrorCode::Io,
            format!("library group worker stopped: {error}"),
        )
    })?
}

pub async fn create_group(
    state: &Arc<AppState>,
    request: CreateGroupRequest,
) -> Result<LibraryGroup, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .create_group(&request.name)
    })
    .await
    .map_err(|error| {
        AppError::new(
            ErrorCode::Io,
            format!("library group worker stopped: {error}"),
        )
    })?
}

pub async fn rename_group(
    state: &Arc<AppState>,
    request: RenameGroupRequest,
) -> Result<LibraryGroup, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .rename_group(&request.id, &request.name)
    })
    .await
    .map_err(|error| {
        AppError::new(
            ErrorCode::Io,
            format!("library group worker stopped: {error}"),
        )
    })?
}

pub async fn delete_group(state: &Arc<AppState>, request: GroupRequest) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .delete_group(&request.id)
    })
    .await
    .map_err(|error| {
        AppError::new(
            ErrorCode::Io,
            format!("library group worker stopped: {error}"),
        )
    })?
}

pub async fn get_txt_encoding(
    state: &Arc<AppState>,
    request: BookRequest,
) -> Result<TxtEncodingInfo, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .txt_encoding_for_book(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("encoding worker stopped: {error}")))?
}

pub async fn reassociate_txt_source(
    state: &Arc<AppState>,
    request: TxtSourceRequest,
) -> Result<TxtEncodingInfo, AppError> {
    let app = state.clone();
    if request.book_id.trim().is_empty() || request.path.trim().is_empty() {
        return Err(AppError::invalid_argument(
            "book_id and source path cannot be empty",
        ));
    }
    let storage = Arc::clone(&state.storage);
    let root = state.data_root.clone();
    let operation_id = Uuid::new_v4().to_string();
    tokio::task::spawn_blocking(move || {
        let snapshot = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .snapshot_txt_reassociation(&request.book_id)?;
        let (source, _staged) = crate::documents::resolve_source(
            &*app.platform,
            &root,
            &request.path,
            &operation_id,
            &AtomicBool::new(false),
        )?;
        let mut prepared =
            Storage::prepare_txt_reassociation(&root, &snapshot, &source, &operation_id)?;
        Storage::verify_prepared_txt_reassociation(&root, &mut prepared)?;
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .commit_txt_reassociation(prepared)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("source worker stopped: {error}")))?
}

pub async fn start_txt_decode(
    state: &Arc<AppState>,
    request: TxtEncodingRequest,
) -> Result<TxtDecodeTask, AppError> {
    let app = state.clone();
    if request.book_id.trim().is_empty() {
        return Err(AppError::invalid_argument("book_id cannot be empty"));
    }
    spawn_txt_decode(state, app, request.book_id, Some(request.encoding))
}

/// Re-derives a book's text when its replace rules or Chinese conversion
/// changed since it was produced, keeping the selected encoding. Returns the
/// decode task, or `None` when the text is already current.
pub async fn ensure_text_transforms(
    state: &Arc<AppState>,
    request: BookRequest,
) -> Result<Option<TxtDecodeTask>, AppError> {
    let app = state.clone();
    // Online chapters take the current transform each time they are read.
    if for_online_book(state, &request.book_id, |_| Ok(()))
        .await?
        .is_some()
    {
        return Ok(None);
    }
    let book_id = request.book_id.clone();
    let pending = with_storage(state, move |storage| {
        storage.text_transform_pending(&book_id)
    })
    .await?;
    if !pending {
        return Ok(None);
    }
    spawn_txt_decode(state, app, request.book_id, None).map(Some)
}

/// Starts the shared re-decode job; `requested` `None` keeps the encoding.
fn spawn_txt_decode(
    state: &AppState,
    app: Arc<AppState>,
    book_id: String,
    requested: Option<TxtEncoding>,
) -> Result<TxtDecodeTask, AppError> {
    let operation_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let initial = TxtDecodeStatus {
        operation_id: operation_id.clone(),
        book_id: book_id.clone(),
        phase: ImportPhase::Staging,
        bytes_read: 0,
        total_bytes: 0,
        result: None,
        error: None,
    };
    let decodes = Arc::clone(&state.txt_decodes);
    decodes
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "TXT decode state lock is poisoned"))?
        .insert(
            operation_id.clone(),
            TxtDecodeOperation {
                cancel: Arc::clone(&cancel),
                status: initial,
            },
        );
    let storage = Arc::clone(&state.storage);
    let root = state.data_root.clone();
    let worker_id = operation_id.clone();
    let worker_decodes = Arc::clone(&decodes);
    let worker_app = app.clone();
    tokio::spawn(async move {
        let blocking_decodes = Arc::clone(&worker_decodes);
        let blocking_app = worker_app.clone();
        let blocking_id = worker_id.clone();
        let blocking_book = book_id.clone();
        let blocking = tokio::task::spawn_blocking(move || {
            let snapshot = {
                let storage = storage
                    .lock()
                    .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
                storage.snapshot_txt_decode(&blocking_book)?
            };
            let requested = requested.unwrap_or_else(|| snapshot.selected_encoding.clone());
            let prepared = Storage::prepare_txt_decode(
                &root,
                &snapshot,
                requested,
                &blocking_id,
                &cancel,
                |phase, bytes_read, total_bytes| {
                    publish_txt_decode_status(
                        &blocking_decodes,
                        &blocking_app,
                        TxtDecodeStatus {
                            operation_id: blocking_id.clone(),
                            book_id: blocking_book.clone(),
                            phase,
                            bytes_read,
                            total_bytes,
                            result: None,
                            error: None,
                        },
                    );
                },
            )?;
            verify_prepared_txt_decode_source(&root, &prepared, &cancel)?;
            let mut storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.commit_txt_decode(prepared, &cancel)
        });
        let result = match blocking.await {
            Ok(result) => result,
            Err(error) => Err(AppError::new(
                ErrorCode::Io,
                format!("TXT decode worker stopped unexpectedly: {error}"),
            )),
        };
        let (phase, info, error) = match result {
            Ok(info) => (ImportPhase::Completed, Some(info), None),
            Err(error) if error.code == ErrorCode::ImportCancelled => {
                (ImportPhase::Cancelled, None, Some(error))
            }
            Err(error) => (ImportPhase::Failed, None, Some(error)),
        };
        publish_txt_decode_status(
            &worker_decodes,
            &worker_app,
            TxtDecodeStatus {
                operation_id: worker_id,
                book_id,
                phase,
                bytes_read: 0,
                total_bytes: 0,
                result: info,
                error,
            },
        );
    });
    Ok(TxtDecodeTask { operation_id })
}

pub async fn get_txt_decode_status(
    state: &Arc<AppState>,
    request: ImportOperationRequest,
) -> Result<TxtDecodeStatus, AppError> {
    let decodes = Arc::clone(&state.txt_decodes);
    tokio::task::spawn_blocking(move || {
        decodes
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "TXT decode state lock is poisoned"))?
            .get(&request.operation_id)
            .map(|operation| operation.status.clone())
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::OperationNotFound,
                    "TXT decode operation was not found",
                )
            })
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("status worker stopped: {error}")))?
}

pub async fn cancel_txt_decode(
    state: &Arc<AppState>,
    request: ImportOperationRequest,
) -> Result<CancelResult, AppError> {
    let decodes = Arc::clone(&state.txt_decodes);
    tokio::task::spawn_blocking(move || {
        let decodes = decodes
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "TXT decode state lock is poisoned"))?;
        let operation = decodes.get(&request.operation_id).ok_or_else(|| {
            AppError::new(
                ErrorCode::OperationNotFound,
                "TXT decode operation was not found",
            )
        })?;
        let terminal = is_terminal(&operation.status.phase);
        if !terminal {
            operation.cancel.store(true, Ordering::Release);
        }
        Ok(CancelResult {
            requested: !terminal,
        })
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("cancel worker stopped: {error}")))?
}

pub async fn set_txt_encoding(
    state: &Arc<AppState>,
    request: TxtEncodingRequest,
) -> Result<TxtEncodingInfo, AppError> {
    let storage = Arc::clone(&state.storage);
    let root = state.data_root.clone();
    let operation_id = Uuid::new_v4().to_string();
    tokio::task::spawn_blocking(move || {
        let snapshot = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .snapshot_txt_decode(&request.book_id)?;
        let prepared = Storage::prepare_txt_decode(
            &root,
            &snapshot,
            request.encoding,
            &operation_id,
            &AtomicBool::new(false),
            |_, _, _| {},
        )?;
        verify_prepared_txt_decode_source(&root, &prepared, &AtomicBool::new(false))?;
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .commit_txt_decode(prepared, &AtomicBool::new(false))
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("encoding worker stopped: {error}")))?
}

pub async fn list_toc(state: &Arc<AppState>, request: BookRequest) -> Result<TocListing, AppError> {
    let book_id = request.book_id.clone();
    if let Some(listing) = for_online_book(state, &request.book_id, move |storage| {
        crate::online_reader::toc(storage, &book_id)
    })
    .await?
    {
        return Ok(listing);
    }
    let storage = Arc::clone(&state.storage);
    let builds = Arc::clone(&state.toc_builds);
    tokio::task::spawn_blocking(move || {
        let build = list_toc_current(&storage, &builds, &request.book_id)?;
        let (settings, titles) = {
            let guard = lock_storage(&storage)?;
            (
                guard.book_toc_settings(&request.book_id)?.0,
                guard.title_transform(&request.book_id)?,
            )
        };
        // Built from the text, which the content rules already changed;
        // the 作用于标题 rules change only how the contents read.
        let mut entries = build.entries;
        for entry in &mut entries {
            entry.title = titles.title(&entry.title);
        }
        Ok(TocListing {
            entries,
            rule_id: build.rule_id,
            rule_name: build.rule_name,
            settings,
        })
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("toc worker stopped: {error}")))?
}

/// The one-time question about a book's contents, when there is one to
/// ask: a disabled rule that finds chapters no enabled rule found, or (for
/// an online book) chapters inside its chapters.
pub async fn toc_suggestion(
    state: &Arc<AppState>,
    request: BookRequest,
) -> Result<Option<crate::models::TocSuggestion>, AppError> {
    let book_id = request.book_id.clone();
    if let Some(found) = for_online_book(state, &request.book_id, move |storage| {
        crate::online_reader::toc_suggestion(storage, &book_id)
    })
    .await?
    {
        return Ok(found);
    }
    let storage = Arc::clone(&state.storage);
    let builds = Arc::clone(&state.toc_builds);
    tokio::task::spawn_blocking(move || {
        let (settings, _) = lock_storage(&storage)?.book_toc_settings(&request.book_id)?;
        if settings.asked || settings.rule_id.is_some() {
            return Ok(None);
        }
        let build = list_toc_current(&storage, &builds, &request.book_id)?;
        if build.rule_id.is_some() {
            return Ok(None);
        }
        let (context, disabled) = {
            let guard = lock_storage(&storage)?;
            let disabled: Vec<crate::txt_toc::RuleSpec> = guard
                .list_txt_toc_rules()?
                .into_iter()
                .filter(|rule| !rule.enabled && !rule.loose && !rule.pattern.is_empty())
                .map(|rule| crate::txt_toc::RuleSpec {
                    id: rule.id,
                    name: rule.name,
                    pattern: rule.pattern,
                })
                .collect();
            (guard.content_read_context(&request.book_id)?, disabled)
        };
        Ok(
            crate::storage::disabled_rule_for(&context, &disabled)?.map(|(rule, titles, count)| {
                crate::models::TocSuggestion {
                    kind: "rule".into(),
                    rule_id: rule.id,
                    rule_name: rule.name,
                    titles,
                    count,
                }
            }),
        )
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("toc worker stopped: {error}")))?
}

fn list_toc_current(
    storage: &Mutex<Storage>,
    builds: &Mutex<HashMap<TocBuildKey, Arc<TocBuildFlight>>>,
    book_id: &str,
) -> Result<TocBuild, AppError> {
    loop {
        let (context, rule, revision, content_version) = {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            let context = storage.content_read_context(book_id)?;
            let (rule, revision) = storage.toc_rule_snapshot(book_id)?;
            let content_version = storage.get_book(book_id)?.content_version;
            (context, rule, revision, content_version)
        };
        let key = TocBuildKey {
            book_id: book_id.to_string(),
            content_version,
            rule_identity: serde_json::to_string(&rule)?,
            rule_revision: revision,
        };
        let (flight, is_builder) = acquire_toc_build(builds, key.clone())?;
        let result = if !is_builder {
            flight.wait()
        } else {
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                let verified = verify_content_context(&context)?;
                if let Some(build) = {
                    let storage = storage.lock().map_err(|_| {
                        AppError::new(ErrorCode::Database, "storage lock is poisoned")
                    })?;
                    let cached = storage.cached_toc(&context, &rule, revision)?;
                    if cached.is_some() {
                        storage.persist_content_index(&context, &verified)?;
                    }
                    cached
                } {
                    return Ok(build);
                }
                let build = build_toc_from_context(&context, &verified, book_id, &rule)?;
                {
                    let storage = storage.lock().map_err(|_| {
                        AppError::new(ErrorCode::Database, "storage lock is poisoned")
                    })?;
                    storage.persist_content_index(&context, &verified)?;
                    storage.cache_toc(&context, &build, &rule, revision)?;
                }
                Ok(build)
            }))
            .unwrap_or_else(|_| {
                Err(AppError::new(
                    ErrorCode::Io,
                    "TOC build worker stopped unexpectedly",
                ))
            });
            flight.complete(result.clone());
            release_toc_build(builds, &key, &flight);
            result
        };
        // A rule save or re-decode can finish while this caller is building
        // or waiting for another caller. Retry from the latest snapshot, so
        // neither old successes nor errors replace the current directory.
        if storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .toc_snapshot_is_current(&context, &rule, revision)?
        {
            return result;
        }
    }
}

fn lock_storage(storage: &Mutex<Storage>) -> Result<std::sync::MutexGuard<'_, Storage>, AppError> {
    storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
}

/// Runs `work` on an engine thread when `book_id` is an online book, which
/// reads chapter by chapter from its source; `None` for a local book.
async fn for_online_book<T: Send + 'static>(
    state: &AppState,
    book_id: &str,
    work: impl FnOnce(&Arc<Mutex<Storage>>) -> Result<T, AppError> + Send + 'static,
) -> Result<Option<T>, AppError> {
    let storage = Arc::clone(&state.storage);
    let id = book_id.to_string();
    let online = {
        let storage = Arc::clone(&storage);
        tokio::task::spawn_blocking(move || lock_storage(&storage)?.is_online_book(&id))
            .await
            .map_err(|error| AppError::new(ErrorCode::Io, format!("worker stopped: {error}")))??
    };
    if !online {
        return Ok(None);
    }
    let started = std::time::Instant::now();
    let outcome = crate::source_commands::on_engine_thread(move || work(&storage)).await?;
    // 详细日志 times every online reading step, to find what stutters.
    if crate::app_log::detailed() {
        crate::log_keyed!(
            Detail,
            "reader",
            "onlineTiming",
            format!("网络书籍操作 {} ms", started.elapsed().as_millis()),
            ms = started.elapsed().as_millis(),
        );
    }
    outcome.map(Some)
}

/// Runs a short storage operation off the async runtime.
pub(crate) async fn with_storage<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&mut Storage) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || operation(&mut *lock_storage(&storage)?))
        .await
        .map_err(|error| AppError::new(ErrorCode::Io, format!("storage worker stopped: {error}")))?
}

pub async fn list_txt_toc_rules(state: &Arc<AppState>) -> Result<Vec<TxtTocRule>, AppError> {
    with_storage(state, |storage| storage.list_txt_toc_rules()).await
}

pub async fn save_txt_toc_rule(
    state: &Arc<AppState>,
    request: SaveTxtTocRuleRequest,
) -> Result<TxtTocRule, AppError> {
    with_storage(state, move |storage| {
        storage.save_txt_toc_rule(&request.rule)
    })
    .await
}

pub async fn delete_txt_toc_rule(
    state: &Arc<AppState>,
    request: TxtTocRuleIdRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.delete_txt_toc_rule(&request.id)
    })
    .await
}

pub async fn order_txt_toc_rules(
    state: &Arc<AppState>,
    request: OrderTxtTocRulesRequest,
) -> Result<Vec<TxtTocRule>, AppError> {
    with_storage(state, move |storage| {
        storage.order_txt_toc_rules(&request.ids)
    })
    .await
}

pub async fn import_txt_toc_rules(
    state: &Arc<AppState>,
    request: ImportTxtTocRulesRequest,
) -> Result<Vec<TxtTocRule>, AppError> {
    with_storage(state, move |storage| {
        storage.import_txt_toc_rules(&request.json)
    })
    .await
}

pub async fn export_txt_toc_rules(state: &Arc<AppState>) -> Result<String, AppError> {
    with_storage(state, |storage| storage.export_txt_toc_rules()).await
}

pub async fn test_txt_toc_rule(
    _state: &Arc<AppState>,
    request: TestTxtTocRuleRequest,
) -> Result<Vec<String>, AppError> {
    crate::txt_toc::test_rule(&request.pattern, &request.sample)
}

pub async fn save_book_toc_settings(
    state: &Arc<AppState>,
    request: SaveBookTocSettingsRequest,
) -> Result<BookTocSettings, AppError> {
    with_storage(state, move |storage| {
        storage.save_book_toc_settings(&request.book_id, &request.settings)
    })
    .await
}

pub async fn import_reader_font(
    state: &Arc<AppState>,
    request: crate::models::PathRequest,
) -> Result<crate::models::ReaderAsset, AppError> {
    let app = state.clone();
    let root = state.data_root.clone();
    let operation_id = Uuid::new_v4().to_string();
    with_storage(state, move |storage| {
        let (path, name, _staged) = crate::documents::resolve_named_source(
            &*app.platform,
            &root,
            &request.path,
            &operation_id,
        )?;
        storage.import_reader_font(&path, &name)
    })
    .await
}

pub async fn list_reader_fonts(
    state: &Arc<AppState>,
) -> Result<Vec<crate::models::ReaderAsset>, AppError> {
    with_storage(state, |storage| storage.list_reader_fonts()).await
}

/// Font bytes as a raw IPC response, so the page can load them with FontFace.
pub async fn read_reader_font(
    state: &Arc<AppState>,
    request: crate::models::ReaderAssetRequest,
) -> Result<Vec<u8>, AppError> {
    let bytes = with_storage(state, move |storage| storage.read_reader_font(&request.id)).await?;
    Ok(bytes)
}

pub async fn delete_reader_font(
    state: &Arc<AppState>,
    request: crate::models::ReaderAssetRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.delete_reader_font(&request.id)
    })
    .await
}

pub async fn get_book_info(
    state: &Arc<AppState>,
    request: BookRequest,
) -> Result<BookInfo, AppError> {
    with_storage(state, move |storage| storage.book_info(&request.book_id)).await
}

pub async fn list_bookmarks(
    state: &Arc<AppState>,
    request: BookRequest,
) -> Result<Vec<Bookmark>, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .list_bookmarks(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("bookmark worker stopped: {error}")))?
}

pub async fn add_bookmark(
    state: &Arc<AppState>,
    request: BookmarkRequest,
) -> Result<Bookmark, AppError> {
    let online_request = request.clone();
    if let Some(bookmark) = for_online_book(state, &request.book_id, move |storage| {
        lock_storage(storage)?.insert_bookmark(&online_request)
    })
    .await?
    {
        return Ok(bookmark);
    }
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        let context = {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.content_read_context(&request.book_id)?
        };
        let verified = verify_content_context(&context)?;
        let storage = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        storage.persist_content_index(&context, &verified)?;
        storage.add_bookmark_from_context(&context, &verified, &request)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("bookmark worker stopped: {error}")))?
}

pub async fn delete_bookmark(
    state: &Arc<AppState>,
    request: BookmarkIdRequest,
) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .delete_bookmark(&request.bookmark_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("bookmark worker stopped: {error}")))?
}

pub async fn search_book(
    state: &Arc<AppState>,
    request: SearchRequest,
) -> Result<SearchResponse, AppError> {
    let online_request = request.clone();
    if let Some(response) = for_online_book(state, &request.book_id, move |storage| {
        crate::online_reader::search(storage, &online_request)
    })
    .await?
    {
        return Ok(response);
    }
    let storage = Arc::clone(&state.storage);
    let cancel = if let Some(operation_id) = request.operation_id.as_deref() {
        if operation_id.trim().is_empty() {
            return Err(AppError::invalid_argument(
                "search operation_id cannot be empty",
            ));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        state
            .searches
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "search state lock is poisoned"))?
            .insert(operation_id.to_string(), Arc::clone(&cancel));
        Some(cancel)
    } else {
        None
    };
    let searches = Arc::clone(&state.searches);
    let operation_id = request.operation_id.clone();
    tokio::task::spawn_blocking(move || {
        let result = (|| {
            let context = {
                let storage = storage
                    .lock()
                    .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
                storage.content_read_context(&request.book_id)?
            };
            if cancel
                .as_deref()
                .is_some_and(|token| token.load(Ordering::Acquire))
            {
                return Err(AppError::new(
                    ErrorCode::ImportCancelled,
                    "search was cancelled",
                ));
            }
            let verified = verify_content_context(&context)?;
            {
                let storage = storage
                    .lock()
                    .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
                storage.persist_content_index(&context, &verified)?;
            }
            Storage::search_book_from_context_cancelable(
                &request,
                &context,
                &verified,
                cancel.as_deref(),
            )
        })();
        if let Some(operation_id) = operation_id {
            if let Ok(mut searches) = searches.lock() {
                searches.remove(&operation_id);
            }
        }
        result
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("search worker stopped: {error}")))?
}

pub async fn cancel_search(
    state: &Arc<AppState>,
    request: ImportOperationRequest,
) -> Result<CancelResult, AppError> {
    let searches = Arc::clone(&state.searches);
    tokio::task::spawn_blocking(move || {
        let searches = searches
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "search state lock is poisoned"))?;
        let Some(cancel) = searches.get(&request.operation_id) else {
            return Ok(CancelResult { requested: false });
        };
        cancel.store(true, Ordering::Release);
        Ok(CancelResult { requested: true })
    })
    .await
    .map_err(|error| {
        AppError::new(
            ErrorCode::Io,
            format!("search cancellation stopped: {error}"),
        )
    })?
}

pub async fn read_content_window(
    state: &Arc<AppState>,
    request: ReadContentRequest,
) -> Result<ContentWindow, AppError> {
    let online_request = request.clone();
    if let Some(window) = for_online_book(state, &request.book_id, move |storage| {
        crate::online_reader::read_window(storage, &online_request)
    })
    .await?
    {
        return Ok(window);
    }
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        let context = {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.content_read_context(&request.book_id)?
        };
        let verified = verify_content_context(&context)?;
        {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.persist_content_index(&context, &verified)?;
        }
        read_content_window_from_context(&request, &context, &verified)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("content worker stopped: {error}")))?
}

pub async fn resolve_reader_locator(
    state: &Arc<AppState>,
    request: ResolveLocatorRequest,
) -> Result<ReaderLocator, AppError> {
    let (book_id, progress) = (request.book_id.clone(), request.progress);
    if let Some(locator) = for_online_book(state, &request.book_id, move |storage| {
        crate::online_reader::resolve_progress(storage, &book_id, progress)
    })
    .await?
    {
        return Ok(locator);
    }
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        if !request.progress.is_finite() || !(0.0..=1.0).contains(&request.progress) {
            return Err(AppError::invalid_argument(
                "reader progress must be a finite number between 0 and 1",
            ));
        }
        let context = {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.content_read_context(&request.book_id)?
        };
        let verified = verify_content_context(&context)?;
        {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.persist_content_index(&context, &verified)?;
        }
        resolve_locator_from_context(&request, &context, &verified)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("locator worker stopped: {error}")))?
}

pub async fn resolve_reader_offset(
    state: &Arc<AppState>,
    request: ResolveOffsetRequest,
) -> Result<ReaderLocator, AppError> {
    let online_request = request.clone();
    if let Some(locator) = for_online_book(state, &request.book_id, move |storage| {
        crate::online_reader::resolve_offset(storage, &online_request)
    })
    .await?
    {
        return Ok(locator);
    }
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        let context = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .content_read_context(&request.book_id)?;
        let verified = verify_content_context(&context)?;
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .persist_content_index(&context, &verified)?;
        resolve_offset_from_context(&request, &context, &verified)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("locator worker stopped: {error}")))?
}

pub async fn save_reader_locator(
    state: &Arc<AppState>,
    request: SaveLocatorRequest,
) -> Result<ReaderLocator, AppError> {
    let locator = request.locator.clone();
    if let Some(saved) = for_online_book(state, &request.locator.book_id, move |storage| {
        let guard = lock_storage(storage)?;
        let index = crate::storage::resource_chapter(&locator.resource_id).ok_or_else(|| {
            AppError::keyed(
                ErrorCode::InvalidArgument,
                "notOnlineChapter",
                "不是网络书籍的章节",
            )
        })?;
        guard
            .online_chapter(&locator.book_id, index)?
            .ok_or_else(|| AppError::keyed(ErrorCode::NotFound, "chapterMissing", "没有这一章"))?;
        guard.save_position_record(&locator)?;
        Ok(locator)
    })
    .await?
    {
        return Ok(saved);
    }
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        let context = {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.content_read_context(&request.locator.book_id)?
        };
        let verified = verify_content_context(&context)?;
        validate_content_locator(&context, &verified, &request.locator)?;
        {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.persist_content_index(&context, &verified)?;
            storage.save_position_record(&request.locator)?;
        }
        Ok(request.locator)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("position worker stopped: {error}")))?
}

pub async fn get_saved_reader_locator(
    state: &Arc<AppState>,
    request: BookRequest,
) -> Result<Option<ReaderLocator>, AppError> {
    // A restored online book places its position once its contents are known.
    let book_id = request.book_id.clone();
    if let Some(saved) = for_online_book(state, &request.book_id, move |storage| {
        if lock_storage(storage)?
            .pending_online_position(&book_id)?
            .is_some()
        {
            let _ = crate::online_reader::ensure_toc(storage, &book_id);
            lock_storage(storage)?.settle_pending_online_position(&book_id)?;
        }
        lock_storage(storage)?.saved_position(&book_id)
    })
    .await?
    {
        return Ok(saved);
    }
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        storage.saved_position(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("position worker stopped: {error}")))?
}

pub async fn get_settings(state: &Arc<AppState>) -> Result<ReaderPreferences, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        storage.get_settings()
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("settings worker stopped: {error}")))?
}

pub async fn save_settings(
    state: &Arc<AppState>,
    request: SaveSettingsRequest,
) -> Result<ReaderPreferences, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        storage.save_settings(&request.settings)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("settings worker stopped: {error}")))?
}

fn completed_status(operation_id: &str, result: ImportResult) -> ImportStatus {
    ImportStatus {
        operation_id: operation_id.to_string(),
        phase: ImportPhase::Completed,
        bytes_read: result.source_byte_length,
        total_bytes: result.source_byte_length,
        result: Some(result),
        error: None,
    }
}

fn terminal_status(
    imports: &Mutex<HashMap<String, ImportOperation>>,
    operation_id: &str,
    phase: ImportPhase,
    error: AppError,
) -> ImportStatus {
    let (bytes_read, total_bytes) = imports
        .lock()
        .ok()
        .and_then(|operations| {
            operations
                .get(operation_id)
                .map(|operation| (operation.status.bytes_read, operation.status.total_bytes))
        })
        .unwrap_or_default();
    ImportStatus {
        operation_id: operation_id.to_string(),
        phase,
        bytes_read,
        total_bytes,
        result: None,
        error: Some(error),
    }
}

fn is_terminal(phase: &ImportPhase) -> bool {
    matches!(
        phase,
        ImportPhase::Completed | ImportPhase::Failed | ImportPhase::Cancelled
    )
}

fn publish_import_status(
    imports: &Mutex<HashMap<String, ImportOperation>>,
    app: &AppState,
    status: ImportStatus,
) {
    let should_emit = if let Ok(mut operations) = imports.lock() {
        if let Some(operation) = operations.get_mut(&status.operation_id) {
            if is_terminal(&operation.status.phase) {
                false
            } else {
                operation.status = status.clone();
                true
            }
        } else {
            false
        }
    } else {
        false
    };
    if should_emit {
        let _ = app.emit("import-progress", status);
    }
}

fn publish_txt_decode_status(
    decodes: &Mutex<HashMap<String, TxtDecodeOperation>>,
    app: &AppState,
    status: TxtDecodeStatus,
) {
    let next_status = if let Ok(mut operations) = decodes.lock() {
        if let Some(operation) = operations.get_mut(&status.operation_id) {
            if is_terminal(&operation.status.phase) {
                None
            } else {
                let mut next = status.clone();
                if next.total_bytes == 0 {
                    next.bytes_read = operation.status.bytes_read;
                    next.total_bytes = operation.status.total_bytes;
                }
                operation.status = next.clone();
                Some(next)
            }
        } else {
            None
        }
    } else {
        None
    };
    if let Some(status) = next_status {
        let _ = app.emit("txt-decode-progress", status);
    }
}

pub async fn update_book(
    state: &Arc<AppState>,
    request: crate::models::UpdateBookRequest,
) -> Result<crate::models::Book, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .update_book(&request)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
/// A deleted online book's downloads go with it.
fn forget_downloads(app: &AppState, book_id: &str) {
    app.downloads().forget_book(book_id);
}

pub async fn remove_book(state: &Arc<AppState>, request: BookRequest) -> Result<(), AppError> {
    let app = state.clone();
    // Legado deletes an online book outright; its text is only a cache.
    let book_id = request.book_id.clone();
    if for_online_book(state, &request.book_id, move |storage| {
        lock_storage(storage)?.delete_online_book(&book_id)
    })
    .await?
    .is_some()
    {
        forget_downloads(&app, &request.book_id);
        return Ok(());
    }
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .remove_book(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
pub async fn restore_book(state: &Arc<AppState>, request: BookRequest) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .restore_book(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
pub async fn list_removed_books(state: &Arc<AppState>) -> Result<Vec<LibraryBook>, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .list_removed_books()
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
pub async fn get_shelf_preferences(
    state: &Arc<AppState>,
) -> Result<crate::models::ShelfPreferences, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .get_shelf_preferences()
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
pub async fn save_shelf_preferences(
    state: &Arc<AppState>,
    request: crate::models::SaveShelfPreferencesRequest,
) -> Result<crate::models::ShelfPreferences, AppError> {
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .save_shelf_preferences(&request.preferences)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}

pub async fn move_book(
    state: &Arc<AppState>,
    request: crate::models::MoveBookRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.move_book(&request.book_id, &request.placement)
    })
    .await
}

pub async fn update_bookmark_note(
    state: &Arc<AppState>,
    request: crate::models::BookmarkNoteRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.update_bookmark_note(&request.bookmark_id, &request.note)
    })
    .await
}

pub async fn add_reading_time(
    state: &Arc<AppState>,
    request: crate::models::ReadingTimeRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.add_reading_time(&request.book_id, &request.day, request.seconds)
    })
    .await
}

pub async fn reading_stats(
    state: &Arc<AppState>,
    request: crate::models::ReadingStatsRequest,
) -> Result<crate::models::ReadingStats, AppError> {
    with_storage(state, move |storage| storage.reading_stats(&request.today)).await
}

pub async fn set_book_cover(
    state: &Arc<AppState>,
    request: crate::models::BookCoverRequest,
) -> Result<crate::models::ReaderAsset, AppError> {
    let app = state.clone();
    let root = state.data_root.clone();
    let operation_id = Uuid::new_v4().to_string();
    with_storage(state, move |storage| {
        let (path, name, _staged) = crate::documents::resolve_named_source(
            &*app.platform,
            &root,
            &request.path,
            &operation_id,
        )?;
        storage.set_book_cover(&request.book_id, &path, &name)
    })
    .await
}

/// The sizes of a book's images (an EPUB's, or an online book's kept
/// chapter pictures), by the index its text marks carry.
pub async fn list_book_images(
    state: &Arc<AppState>,
    request: BookRequest,
) -> Result<Vec<crate::models::BookImage>, AppError> {
    with_storage(state, move |storage| storage.book_images(&request.book_id)).await
}

/// One image's bytes.
pub async fn read_book_image(
    state: &Arc<AppState>,
    request: crate::models::BookImageRequest,
) -> Result<Vec<u8>, AppError> {
    let request_online = request.clone();
    let online = with_storage(state, move |storage| {
        if !storage.is_online_book(&request_online.book_id)? {
            return Ok(None);
        }
        Ok(Some(storage.online_image_path(
            &request_online.book_id,
            request_online.index,
        )))
    })
    .await?;
    // An online book's pictures are kept with its chapters.
    if let Some(path) = online {
        return std::fs::read(&path)
            .map_err(|_| AppError::keyed(ErrorCode::NotFound, "imageMissing", "没有这张图片"));
    }
    let (source, inner) = with_storage(state, move |storage| {
        storage.book_image_location(&request.book_id, request.index)
    })
    .await?;
    tokio::task::spawn_blocking(move || crate::epub::read_file_at(&source, &inner))
        .await
        .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}

pub async fn clear_book_cover(state: &Arc<AppState>, request: BookRequest) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.clear_book_cover(&request.book_id)
    })
    .await
}

/// TXT files in a folder for batch import: on Android the system folder
/// picker runs here and `path` is ignored; elsewhere `path` is the folder.
pub async fn list_txt_folder(
    state: &Arc<AppState>,
    request: crate::models::PathRequest,
) -> Result<Vec<crate::models::PickedFile>, AppError> {
    let app = state.clone();
    tokio::task::spawn_blocking(move || {
        crate::documents::list_txt_folder(&*app.platform, &request.path)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("folder worker stopped: {error}")))?
}

pub async fn import_reader_background(
    state: &Arc<AppState>,
    request: crate::models::PathRequest,
) -> Result<crate::models::ReaderAsset, AppError> {
    let app = state.clone();
    let root = state.data_root.clone();
    let operation_id = Uuid::new_v4().to_string();
    with_storage(state, move |storage| {
        let (path, name, _staged) = crate::documents::resolve_named_source(
            &*app.platform,
            &root,
            &request.path,
            &operation_id,
        )?;
        storage.import_reader_background(&path, &name)
    })
    .await
}

pub async fn list_replace_rules(
    state: &Arc<AppState>,
) -> Result<Vec<crate::models::ReplaceRule>, AppError> {
    with_storage(state, |storage| storage.list_replace_rules()).await
}

pub async fn save_replace_rule(
    state: &Arc<AppState>,
    request: crate::models::SaveReplaceRuleRequest,
) -> Result<crate::models::ReplaceRule, AppError> {
    with_storage(state, move |storage| {
        storage.save_replace_rule(&request.rule)
    })
    .await
}

pub async fn delete_replace_rules(
    state: &Arc<AppState>,
    request: crate::models::ReplaceRuleIdsRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.delete_replace_rules(&request.ids)
    })
    .await
}

pub async fn order_replace_rules(
    state: &Arc<AppState>,
    request: crate::models::ReplaceRuleIdsRequest,
) -> Result<Vec<crate::models::ReplaceRule>, AppError> {
    with_storage(state, move |storage| {
        storage.order_replace_rules(&request.ids)
    })
    .await
}

pub async fn import_replace_rules(
    state: &Arc<AppState>,
    request: crate::models::ImportReplaceRulesRequest,
) -> Result<Vec<crate::models::ReplaceRule>, AppError> {
    with_storage(state, move |storage| {
        storage.import_replace_rules(&request.json, request.chosen.as_deref())
    })
    .await
}

pub async fn preview_replace_rules(
    state: &Arc<AppState>,
    request: ImportTxtTocRulesRequest,
) -> Result<crate::models::ReplaceRuleImportPreview, AppError> {
    with_storage(state, move |storage| {
        storage.preview_replace_rules(&request.json)
    })
    .await
}

pub async fn export_replace_rules(state: &Arc<AppState>) -> Result<String, AppError> {
    with_storage(state, |storage| storage.export_replace_rules()).await
}

/// Applies one rule to sample text, for the rule editor.
pub async fn test_replace_rule(
    _state: &Arc<AppState>,
    request: crate::models::TestReplaceRuleRequest,
) -> Result<String, AppError> {
    let rule = crate::transform::TransformRule {
        pattern: request.rule.pattern,
        replacement: request.rule.replacement,
        regex: request.rule.is_regex,
    };
    crate::transform::validate_rule(&rule)?;
    let transform = crate::transform::TextTransform {
        rules: vec![rule],
        chinese: crate::models::ChineseConversion::Off,
        translation: None,
    };
    Ok(crate::transform::apply(&request.sample, &transform).0)
}

pub async fn set_book_replace_rules(
    state: &Arc<AppState>,
    request: crate::models::BookReplaceRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.set_book_replace_rules(&request.book_id, request.enabled)
    })
    .await
}

/// The platform recorded in backups, for display when restoring.
fn device_name() -> &'static str {
    match std::env::consts::OS {
        "android" => "Android",
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        "ios" => "iOS",
        other => other,
    }
}

/// Runs WebDAV work off the async runtime; it locks storage only briefly.
async fn with_cloud<T: Send + 'static>(
    state: &AppState,
    operation: impl FnOnce(&Mutex<Storage>, &std::path::Path) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let storage = Arc::clone(&state.storage);
    let root = state.data_root.clone();
    tokio::task::spawn_blocking(move || operation(&storage, &root))
        .await
        .map_err(|error| AppError::new(ErrorCode::Io, format!("cloud worker stopped: {error}")))?
}

fn merged_webdav(
    storage: &Storage,
    request: &crate::models::SaveWebDavRequest,
) -> Result<crate::storage::StoredWebDav, AppError> {
    let mut settings = storage.stored_webdav()?;
    let url = request.url.trim().to_string();
    if !url.is_empty() && !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::invalid_argument(
            "the WebDAV address must start with https:// or http://",
        ));
    }
    let folder = request.folder.trim().trim_matches('/').to_string();
    if folder.contains("..") || folder.contains('\\') {
        return Err(AppError::invalid_argument(
            "the WebDAV folder name is invalid",
        ));
    }
    settings.url = url;
    settings.username = request.username.trim().to_string();
    if let Some(password) = &request.password {
        settings.password = password.clone();
    }
    settings.folder = folder;
    settings.device_name = request.device_name.trim().chars().take(40).collect();
    settings.auto_backup = request.auto_backup;
    settings.sync_progress = request.sync_progress;
    settings.sync_progress_plus = request.sync_progress_plus;
    if let Some(on) = request.auto_sync_book_info {
        settings.auto_sync_book_info = on;
    }
    settings.restore_ignore = request.restore_ignore.clone();
    Ok(settings)
}

/// Writes a backup into the local backup folder (a path, or an Android tree URI).
fn write_local_backup(
    app: &AppState,
    folder: &str,
    name: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    crate::documents::write_to_folder(&*app.platform, folder, name, "application/json", bytes)
}

/// While the GripRead server is connected, WebDAV pauses (its settings stay).
fn webdav_paused(state: &AppState) -> Result<(), AppError> {
    if state.sync.connected() {
        return Err(AppError::keyed(
            ErrorCode::InvalidArgument,
            "webdavPaused",
            "已连接服务器，WebDAV 已暂停",
        ));
    }
    Ok(())
}

/// 设置 › 服务器.
pub async fn get_sync_server(
    state: &Arc<AppState>,
) -> Result<crate::models::SyncServerStatus, AppError> {
    Ok(state.sync.status())
}

pub async fn connect_sync_server(
    state: &Arc<AppState>,
    request: crate::models::ConnectSyncServerRequest,
) -> Result<crate::models::SyncServerStatus, AppError> {
    let sync = state.sync.clone();
    tokio::task::spawn_blocking(move || sync.connect(&request))
        .await
        .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}

pub async fn disconnect_sync_server(
    state: &Arc<AppState>,
) -> Result<crate::models::SyncServerStatus, AppError> {
    let sync = state.sync.clone();
    tokio::task::spawn_blocking(move || sync.disconnect())
        .await
        .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?;
    Ok(state.sync.status())
}

pub fn sync_now(state: &Arc<AppState>) {
    state.sync.now();
}

pub fn set_sync_update_via_server(
    state: &Arc<AppState>,
    request: crate::models::SwitchRequest,
) -> crate::models::SyncServerStatus {
    state.sync.set_update_via_server(request.on);
    state.sync.status()
}

pub fn set_sync_auto_download(
    state: &Arc<AppState>,
    request: crate::models::SwitchRequest,
) -> crate::models::SyncServerStatus {
    state.sync.set_auto_download(request.on);
    state.sync.status()
}

/// The reader opened or closed a book: another device's position for it is
/// offered while it stays open.
pub fn set_sync_open_book(state: &Arc<AppState>, request: crate::models::OptionalPathRequest) {
    state
        .sync
        .set_open_book(request.path.filter(|id| !id.is_empty()));
}

pub async fn get_webdav_settings(
    state: &Arc<AppState>,
) -> Result<crate::models::WebDavSettings, AppError> {
    with_storage(state, |storage| Ok(storage.stored_webdav()?.view())).await
}

pub async fn save_webdav_settings(
    state: &Arc<AppState>,
    request: crate::models::SaveWebDavRequest,
) -> Result<crate::models::WebDavSettings, AppError> {
    with_storage(state, move |storage| {
        let settings = merged_webdav(storage, &request)?;
        storage.save_stored_webdav(&settings)?;
        Ok(settings.view())
    })
    .await
}

/// Checks an address and account before saving them, with the round trip time.
pub async fn test_webdav(
    state: &Arc<AppState>,
    request: crate::models::SaveWebDavRequest,
) -> Result<crate::models::WebDavCheck, AppError> {
    with_cloud(state, move |storage, _| {
        let settings = merged_webdav(&*lock_storage(storage)?, &request)?;
        crate::cloud::check(&settings)
    })
    .await
}

/// A manual backup to WebDAV, also written to the local backup folder when one is chosen.
pub async fn backup_to_webdav(
    state: &Arc<AppState>,
) -> Result<crate::models::RemoteBackup, AppError> {
    webdav_paused(state)?;
    let app = state.clone();
    with_cloud(state, move |storage, _| {
        let (backup, document) = crate::cloud::backup_now(storage, device_name())?;
        crate::log_keyed!(
            Info,
            "sync",
            "backedUp",
            format!("已备份到 WebDAV：{}", backup.name),
            name = backup.name
        );
        let folder = lock_storage(storage)?.stored_webdav()?.local_folder;
        if let Some(folder) = folder {
            write_local_backup(&app, &folder, &backup.name, &serde_json::to_vec(&document)?)?;
        }
        Ok(backup)
    })
    .await
}

/// The daily automatic backup, called at startup; `None` when not due.
pub async fn run_automatic_backup(
    state: &Arc<AppState>,
) -> Result<Option<crate::models::RemoteBackup>, AppError> {
    if state.sync.connected() {
        return Ok(None);
    }
    let app = state.clone();
    with_cloud(state, move |storage, _| {
        crate::cloud::automatic_backup(storage, device_name(), |folder, name, bytes| {
            write_local_backup(&app, folder, name, bytes)
        })
    })
    .await
}

/// Chooses the local backup folder (Legado 备份路径); `path` comes from the
/// desktop folder dialog, Android shows its own picker. `None` clears it.
pub async fn set_backup_folder(
    state: &Arc<AppState>,
    request: crate::models::OptionalPathRequest,
) -> Result<crate::models::WebDavSettings, AppError> {
    let app = state.clone();
    with_cloud(state, move |storage, _| {
        let picked = match request.path.as_deref() {
            Some("") => None,
            path => crate::documents::pick_writable_folder(&*app.platform, path)?,
        };
        let guard = lock_storage(storage)?;
        let mut settings = guard.stored_webdav()?;
        if request.path.as_deref() == Some("") {
            settings.local_folder = None;
            settings.local_folder_label = None;
        } else if let Some((folder, label)) = picked {
            settings.local_folder = Some(folder);
            settings.local_folder_label = Some(label);
        }
        guard.save_stored_webdav(&settings)?;
        Ok(settings.view())
    })
    .await
}

/// Removes a book from the app, and with `cloud` its cloud bookshelf copy.
pub async fn delete_book(
    state: &Arc<AppState>,
    request: crate::models::DeleteBookRequest,
) -> Result<(), AppError> {
    let app = state.clone();
    let book_id = request.book_id.clone();
    if for_online_book(state, &request.book_id, move |storage| {
        lock_storage(storage)?.delete_online_book(&book_id)
    })
    .await?
    .is_some()
    {
        forget_downloads(&app, &request.book_id);
        return Ok(());
    }
    with_cloud(state, move |storage, _| {
        if request.cloud {
            crate::cloud::delete_cloud_copy(storage, &request.book_id)?;
        }
        lock_storage(storage)?.delete_book(&request.book_id)
    })
    .await
}

pub async fn list_remote_backups(
    state: &Arc<AppState>,
) -> Result<Vec<crate::models::RemoteBackup>, AppError> {
    webdav_paused(state)?;
    with_cloud(state, |storage, _| crate::cloud::list_backups(storage)).await
}

pub async fn delete_remote_backup(
    state: &Arc<AppState>,
    request: crate::models::NameRequest,
) -> Result<(), AppError> {
    webdav_paused(state)?;
    with_cloud(state, move |storage, _| {
        crate::cloud::delete_backup(storage, &request.name)
    })
    .await
}

pub async fn list_recovery_points(state: &Arc<AppState>) -> Result<Vec<String>, AppError> {
    with_storage(state, |storage| storage.list_recovery_points()).await
}

pub async fn delete_recovery_point(
    state: &Arc<AppState>,
    request: crate::models::NameRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.delete_recovery_point(&request.name)
    })
    .await
}

fn read_backup_source(
    app: &AppState,
    storage: &Mutex<Storage>,
    root: &std::path::Path,
    source: &crate::models::BackupSource,
) -> Result<crate::storage::BackupDocument, AppError> {
    use crate::models::BackupSource;
    match source {
        BackupSource::Remote(name) => crate::cloud::fetch_backup(storage, name),
        BackupSource::Recovery(name) => lock_storage(storage)?.read_recovery_point(name),
        BackupSource::File(path) => {
            let operation_id = Uuid::new_v4().to_string();
            let (path, _, _staged) =
                crate::documents::resolve_named_source(&*app.platform, root, path, &operation_id)?;
            if std::fs::metadata(&path)?.len() > 64 * 1024 * 1024 {
                return Err(AppError::invalid_argument("the backup file is too large"));
            }
            crate::storage::parse_backup(&std::fs::read(&path)?)
        }
    }
}

pub async fn preview_backup(
    state: &Arc<AppState>,
    request: crate::models::BackupSourceRequest,
) -> Result<crate::models::BackupPreview, AppError> {
    let app = state.clone();
    with_cloud(state, move |storage, root| {
        let document = read_backup_source(&app, storage, root, &request.source)?;
        lock_storage(storage)?.preview_backup(&document)
    })
    .await
}

/// Writes a recovery point, then merges the backup into the library.
pub async fn restore_backup(
    state: &Arc<AppState>,
    request: crate::models::BackupSourceRequest,
) -> Result<crate::models::RestoreReport, AppError> {
    let app = state.clone();
    with_cloud(state, move |storage, root| {
        let document = read_backup_source(&app, storage, root, &request.source)?;
        // Covers come from the cloud when an account is set; a backup still
        // restores without them.
        if lock_storage(storage)?.stored_webdav()?.configured() {
            if let Err(error) = crate::cloud::fetch_backup_covers(storage, &document) {
                crate::log_keyed!(Warn, "sync", "restoreCoverFailed", format!("恢复时封面下载失败：{}", error.message), @error error);
            }
        }
        let mut guard = lock_storage(storage)?;
        let device = guard.stored_webdav()?.device(device_name());
        let recovery_point = guard.write_recovery_point(&device)?;
        let mut report = guard.restore_backup(&document)?;
        report.recovery_point = recovery_point;
        crate::log_keyed!(
            Info,
            "sync",
            "restored",
            format!(
                "已恢复备份：书籍 {}，网络书籍 {}，书源 {}，进度 {}，书签 {}",
                report.books_restored,
                report.online_books_restored,
                report.sources_restored,
                report.positions_restored,
                report.bookmarks_added
            ),
            books = report.books_restored,
            online = report.online_books_restored,
            sources = report.sources_restored,
            positions = report.positions_restored,
            bookmarks = report.bookmarks_added,
        );
        Ok(report)
    })
    .await
}

/// Saves the current records to a file the reader picks (`path` comes from
/// the desktop save dialog; Android shows its own screen). `false`: cancelled.
pub async fn export_backup_file(
    state: &Arc<AppState>,
    request: crate::models::OptionalPathRequest,
) -> Result<bool, AppError> {
    let app = state.clone();
    with_cloud(state, move |storage, _| {
        let guard = lock_storage(storage)?;
        let document = guard.export_local_backup(&guard.stored_webdav()?.device(device_name()))?;
        drop(guard);
        let bytes = serde_json::to_vec(&document)?;
        let name = format!(
            "gripread-{}",
            crate::cloud::backup_file_name(&document, false)
        );
        crate::documents::save_document(
            &*app.platform,
            request.path.as_deref(),
            &name,
            "application/json",
            &bytes,
        )
    })
    .await
}

/// 云书架: the WebDAV book folder, or the server's books while connected.
pub async fn list_cloud_books(
    state: &Arc<AppState>,
) -> Result<Vec<crate::models::CloudBook>, AppError> {
    if state.sync.connected() {
        let sync = state.sync.clone();
        return with_cloud(state, move |storage, _| {
            crate::cloud::server::list(&sync, storage)
        })
        .await;
    }
    with_cloud(state, |storage, _| crate::cloud::list_cloud_books(storage)).await
}

pub async fn upload_cloud_books(
    state: &Arc<AppState>,
    request: crate::models::BookIdListRequest,
) -> Result<crate::models::CloudUploadReport, AppError> {
    if state.sync.connected() {
        let sync = state.sync.clone();
        return with_cloud(state, move |storage, _| {
            crate::cloud::server::upload(&sync, storage, &request.book_ids)
        })
        .await;
    }
    with_cloud(state, move |storage, _| {
        crate::cloud::upload_books(storage, &request.book_ids, device_name())
    })
    .await
}

/// Downloads a cloud book for import; the import matches it to the shelf.
pub async fn download_cloud_book(
    state: &Arc<AppState>,
    request: crate::models::NameRequest,
) -> Result<crate::models::PickedFile, AppError> {
    if state.sync.connected() {
        let sync = state.sync.clone();
        return with_cloud(state, move |_, root| {
            crate::cloud::server::download(&sync, root, &request.name)
        })
        .await;
    }
    with_cloud(state, move |storage, root| {
        crate::cloud::download_cloud_book(storage, root, &request.name)
    })
    .await
}

pub async fn delete_cloud_book(
    state: &Arc<AppState>,
    request: crate::models::NameRequest,
) -> Result<(), AppError> {
    if state.sync.connected() {
        return Err(AppError::invalid_argument(
            "服务器上的书随书架同步，在网页版的书架上删除",
        ));
    }
    with_cloud(state, move |storage, _| {
        crate::cloud::delete_cloud_book(storage, &request.name)
    })
    .await
}

/// Uploads the open book's position when progress sync is on (Legado 同步阅读进度).
pub async fn upload_book_progress(
    state: &Arc<AppState>,
    request: crate::models::UploadProgressRequest,
) -> Result<bool, AppError> {
    if state.sync.connected() {
        state.sync.now();
        return Ok(true);
    }
    with_cloud(state, move |storage, _| {
        crate::progress_sync::upload(
            storage,
            &request.book_id,
            &request.chapter_title,
            device_name(),
        )
    })
    .await
}

/// Another device's newer position for the book, if it is still to be answered.
pub async fn fetch_book_progress(
    state: &Arc<AppState>,
    request: BookRequest,
) -> Result<Option<crate::models::ProgressPrompt>, AppError> {
    if state.sync.connected() {
        // Opening a book pulls first, so the prompt sees the latest position.
        let sync = state.sync.clone();
        tokio::task::spawn_blocking(move || sync.sync_and_wait(std::time::Duration::from_secs(4)))
            .await
            .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?;
        let storage = state.storage.clone();
        return tokio::task::spawn_blocking(move || {
            Ok(crate::progress_sync::fetch_synced(&storage, &request.book_id)?.flatten())
        })
        .await
        .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?;
    }
    with_cloud(state, move |storage, _| {
        crate::progress_sync::fetch(storage, &request.book_id)
    })
    .await
}

pub async fn acknowledge_book_progress(
    state: &Arc<AppState>,
    request: crate::models::AcknowledgeProgressRequest,
) -> Result<(), AppError> {
    with_cloud(state, move |storage, _| {
        crate::progress_sync::acknowledge(
            storage,
            &request.book_id,
            &request.device_id,
            request.revision,
            request.locator.as_ref(),
        )
    })
    .await
}

pub fn list_log_entries(
    _state: &Arc<AppState>,
    request: crate::models::LogQuery,
) -> crate::models::LogPage {
    crate::models::LogPage {
        entries: crate::app_log::entries(request.level),
        detail_until: crate::app_log::detail_until(),
    }
}

pub fn set_detailed_log(
    _state: &Arc<AppState>,
    request: crate::models::SetFlagRequest,
) -> Option<i64> {
    crate::app_log::set_detailed(request.on)
}

pub fn clear_logs(_state: &Arc<AppState>) {
    crate::app_log::clear();
}

/// The whole log as text, for 复制全部 and sharing.
pub fn export_log_text(_state: &Arc<AppState>) -> String {
    crate::app_log::export_text()
}

/// Errors and steps the page reports (uncaught errors, failed commands).
pub fn log_frontend(_state: &Arc<AppState>, request: crate::models::FrontendLogRequest) {
    let area = if request.area.trim().is_empty() {
        "ui"
    } else {
        request.area.trim()
    };
    if let Some(key) = &request.key {
        let params: Vec<(&str, String)> = request
            .params
            .iter()
            .map(|(name, value)| (name.as_str(), value.clone()))
            .collect();
        crate::app_log::keyed(request.level, area, key, &params, &request.message);
        return;
    }
    match request.level {
        crate::app_log::LogLevel::Error => crate::app_log::error(area, &request.message),
        crate::app_log::LogLevel::Warn => crate::app_log::warn(area, &request.message),
        crate::app_log::LogLevel::Info => crate::app_log::info(area, &request.message),
        crate::app_log::LogLevel::Detail => crate::app_log::detail(area, &request.message),
    }
}

/// Every kept entry, for an export the page writes in its language.
pub fn export_log_entries(_state: &Arc<AppState>) -> Vec<crate::app_log::LogEntry> {
    crate::app_log::all_entries()
}

/// 阅读记录's 删除记录: the book's reading time no longer counts.
pub async fn delete_reading_record(
    state: &Arc<AppState>,
    request: BookRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.delete_reading_record(&request.book_id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("gripread-toc-command-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn wait_for_callers(flight: &Arc<TocBuildFlight>, callers: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        // The registry and test builder each own one reference. Each real
        // command owns another only after joining this exact pending build.
        while Arc::strong_count(flight) < callers + 2 {
            assert!(
                Instant::now() < deadline,
                "TOC requests did not join the pending build"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn coalesced_toc_callers_retry_after_rules_or_content_change() {
        for change_content in [false, true] {
            let root = TestRoot::new();
            let source = root.0.join("chapters.txt");
            std::fs::write(&source, "第一章 开始\nChapter 2\n").unwrap();
            let mut storage = Storage::open(&root.0.join("data")).unwrap();
            let imported = storage
                .import_txt(&source, "toc", &AtomicBool::new(false), |_, _, _| {})
                .unwrap();
            let old_entries = storage.list_toc(&imported.book.id).unwrap();
            let (rule, revision) = storage.toc_rule_snapshot(&imported.book.id).unwrap();
            let key = TocBuildKey {
                book_id: imported.book.id.clone(),
                content_version: imported.book.content_version.clone(),
                rule_identity: serde_json::to_string(&rule).unwrap(),
                rule_revision: revision,
            };
            let storage = Arc::new(Mutex::new(storage));
            let builds = Arc::new(Mutex::new(HashMap::new()));
            let (flight, is_builder) = acquire_toc_build(&builds, key.clone()).unwrap();
            assert!(is_builder);
            let (send, receive) = std::sync::mpsc::channel();
            let workers = (0..2)
                .map(|_| {
                    let storage = Arc::clone(&storage);
                    let builds = Arc::clone(&builds);
                    let book_id = imported.book.id.clone();
                    let send = send.clone();
                    std::thread::spawn(move || {
                        send.send(list_toc_current(&storage, &builds, &book_id))
                            .unwrap()
                    })
                })
                .collect::<Vec<_>>();
            wait_for_callers(&flight, 2);
            let current = {
                let mut storage = storage.lock().unwrap();
                if change_content {
                    storage
                        .set_txt_encoding(&imported.book.id, TxtEncoding::Utf16Le)
                        .unwrap();
                } else {
                    storage
                        .save_book_toc_settings(
                            &imported.book.id,
                            &BookTocSettings {
                                rule_id: Some("legado-12".to_string()),
                                split_long_chapters: false,
                                ..Default::default()
                            },
                        )
                        .unwrap();
                }
                storage.list_toc(&imported.book.id).unwrap()
            };
            assert_ne!(current, old_entries);
            flight.complete(Ok(old_entries));
            release_toc_build(&builds, &key, &flight);
            for _ in 0..2 {
                assert_eq!(
                    receive
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap()
                        .unwrap(),
                    current
                );
            }
            for worker in workers {
                worker.join().unwrap();
            }
            assert!(builds.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn toc_build_failure_releases_registry_and_allows_a_later_retry() {
        let root = TestRoot::new();
        let source = root.0.join("chapters.txt");
        let text = "Chapter 1\nBody\n";
        std::fs::write(&source, text).unwrap();
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let imported = storage
            .import_txt(&source, "toc", &AtomicBool::new(false), |_, _, _| {})
            .unwrap();
        let path = root
            .0
            .join("data/books")
            .join(&imported.book.id)
            .join(format!("{}.txt", imported.asset.id));
        std::fs::remove_file(&path).unwrap();
        let storage = Mutex::new(storage);
        let builds = Mutex::new(HashMap::new());
        assert!(list_toc_current(&storage, &builds, &imported.book.id).is_err());
        assert!(builds.lock().unwrap().is_empty());
        std::fs::write(&path, text).unwrap();
        assert_eq!(
            list_toc_current(&storage, &builds, &imported.book.id)
                .unwrap()
                .entries[0]
                .title,
            "Chapter 1"
        );
        assert!(builds.lock().unwrap().is_empty());
    }
}

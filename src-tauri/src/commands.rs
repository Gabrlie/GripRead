use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::error::{AppError, ErrorCode};
use crate::models::{
    BookInfo, BookRequest, BookTocSettings, Bookmark, BookmarkIdRequest, BookmarkRequest,
    CancelResult, ContentWindow, CreateGroupRequest, GroupRequest, ImportOperationRequest,
    ImportPhase, ImportResult, ImportStatus, ImportTask, ImportTxtTocRulesRequest, LibraryBook,
    LibraryGroup, OrderTxtTocRulesRequest, ReadContentRequest, ReaderLocator, ReaderPreferences,
    RenameGroupRequest, ResolveLocatorRequest, ResolveOffsetRequest, SaveBookTocSettingsRequest,
    SaveLocatorRequest, SaveSettingsRequest, SaveTxtTocRuleRequest, SearchRequest, SearchResponse,
    SetBookGroupsRequest, StartImportRequest, TestTxtTocRuleRequest, TocListing, TxtDecodeStatus,
    TxtDecodeTask, TxtEncoding, TxtEncodingInfo, TxtEncodingRequest, TxtSourceRequest, TxtTocRule,
    TxtTocRuleIdRequest,
};
use crate::storage::{
    before_import_commit, build_toc_from_context, duplicate_validation_retry,
    prepare_import_for_target, read_content_window_from_context, resolve_locator_from_context,
    resolve_offset_from_context, validate_content_locator, validate_import_target,
    verify_content_context, verify_prepared_txt_decode_source, Storage,
};
use crate::txt_toc::TocBuild;

pub struct AppState {
    pub storage: Arc<Mutex<Storage>>,
    pub data_root: PathBuf,
    imports: Arc<Mutex<HashMap<String, ImportOperation>>>,
    txt_decodes: Arc<Mutex<HashMap<String, TxtDecodeOperation>>>,
    searches: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    toc_builds: Arc<Mutex<HashMap<TocBuildKey, Arc<TocBuildFlight>>>>,
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
    pub fn new(data_dir: PathBuf) -> Result<Self, AppError> {
        let storage = Storage::open(&data_dir)?;
        let data_root = storage.root_path().to_path_buf();
        // Storage now holds the exclusive data lock, so no other process owns these copies.
        crate::documents::clear_staging(&data_root)?;
        Ok(Self {
            storage: Arc::new(Mutex::new(storage)),
            data_root,
            imports: Arc::new(Mutex::new(HashMap::new())),
            txt_decodes: Arc::new(Mutex::new(HashMap::new())),
            searches: Arc::new(Mutex::new(HashMap::new())),
            toc_builds: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

#[tauri::command]
pub async fn start_import(
    request: StartImportRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ImportTask, AppError> {
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
    tauri::async_runtime::spawn(async move {
        let blocking_operation_id = worker_operation_id.clone();
        let blocking_imports = Arc::clone(&worker_imports);
        let blocking_app = worker_app.clone();
        let blocking = tauri::async_runtime::spawn_blocking(move || {
            // A staged document copy stays alive until this worker finishes,
            // because commit still derives the title from the source path.
            let (source, _staged) = crate::documents::resolve_source(
                &blocking_app,
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
                let built = tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn get_import_status(
    request: ImportOperationRequest,
    state: State<'_, AppState>,
) -> Result<ImportStatus, AppError> {
    let imports = Arc::clone(&state.imports);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn cancel_import(
    request: ImportOperationRequest,
    state: State<'_, AppState>,
) -> Result<CancelResult, AppError> {
    let imports = Arc::clone(&state.imports);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn list_books(state: State<'_, AppState>) -> Result<Vec<LibraryBook>, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        storage.list_library_books()
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("library worker stopped: {error}")))?
}

#[tauri::command]
pub async fn list_groups(state: State<'_, AppState>) -> Result<Vec<LibraryGroup>, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn create_group(
    request: CreateGroupRequest,
    state: State<'_, AppState>,
) -> Result<LibraryGroup, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn rename_group(
    request: RenameGroupRequest,
    state: State<'_, AppState>,
) -> Result<LibraryGroup, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn delete_group(
    request: GroupRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn set_book_groups(
    request: SetBookGroupsRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .set_book_groups(&request.book_id, &request.group_ids)
    })
    .await
    .map_err(|error| {
        AppError::new(
            ErrorCode::Io,
            format!("library group worker stopped: {error}"),
        )
    })?
}

#[tauri::command]
pub async fn get_txt_encoding(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<TxtEncodingInfo, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .txt_encoding_for_book(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("encoding worker stopped: {error}")))?
}

#[tauri::command]
pub async fn reassociate_txt_source(
    request: TxtSourceRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<TxtEncodingInfo, AppError> {
    if request.book_id.trim().is_empty() || request.path.trim().is_empty() {
        return Err(AppError::invalid_argument(
            "book_id and source path cannot be empty",
        ));
    }
    let storage = Arc::clone(&state.storage);
    let root = state.data_root.clone();
    let operation_id = Uuid::new_v4().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .snapshot_txt_reassociation(&request.book_id)?;
        let (source, _staged) = crate::documents::resolve_source(
            &app,
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

#[tauri::command]
pub async fn start_txt_decode(
    request: TxtEncodingRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<TxtDecodeTask, AppError> {
    if request.book_id.trim().is_empty() {
        return Err(AppError::invalid_argument("book_id cannot be empty"));
    }
    let operation_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let initial = TxtDecodeStatus {
        operation_id: operation_id.clone(),
        book_id: request.book_id.clone(),
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
    let book_id = request.book_id;
    let requested = request.encoding;
    let worker_id = operation_id.clone();
    let worker_decodes = Arc::clone(&decodes);
    let worker_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let blocking_decodes = Arc::clone(&worker_decodes);
        let blocking_app = worker_app.clone();
        let blocking_id = worker_id.clone();
        let blocking_book = book_id.clone();
        let blocking = tauri::async_runtime::spawn_blocking(move || {
            let snapshot = {
                let storage = storage
                    .lock()
                    .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
                storage.snapshot_txt_decode(&blocking_book)?
            };
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

#[tauri::command]
pub async fn get_txt_decode_status(
    request: ImportOperationRequest,
    state: State<'_, AppState>,
) -> Result<TxtDecodeStatus, AppError> {
    let decodes = Arc::clone(&state.txt_decodes);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn cancel_txt_decode(
    request: ImportOperationRequest,
    state: State<'_, AppState>,
) -> Result<CancelResult, AppError> {
    let decodes = Arc::clone(&state.txt_decodes);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn set_txt_encoding(
    request: TxtEncodingRequest,
    state: State<'_, AppState>,
) -> Result<TxtEncodingInfo, AppError> {
    let storage = Arc::clone(&state.storage);
    let root = state.data_root.clone();
    let operation_id = Uuid::new_v4().to_string();
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn list_toc(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<TocListing, AppError> {
    let storage = Arc::clone(&state.storage);
    let builds = Arc::clone(&state.toc_builds);
    tauri::async_runtime::spawn_blocking(move || {
        let build = list_toc_current(&storage, &builds, &request.book_id)?;
        let (settings, _) = lock_storage(&storage)?.book_toc_settings(&request.book_id)?;
        Ok(TocListing {
            entries: build.entries,
            rule_id: build.rule_id,
            rule_name: build.rule_name,
            settings,
        })
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

/// Runs a short storage operation off the async runtime.
async fn with_storage<T: Send + 'static>(
    state: &State<'_, AppState>,
    operation: impl FnOnce(&mut Storage) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || operation(&mut *lock_storage(&storage)?))
        .await
        .map_err(|error| AppError::new(ErrorCode::Io, format!("storage worker stopped: {error}")))?
}

#[tauri::command]
pub async fn list_txt_toc_rules(state: State<'_, AppState>) -> Result<Vec<TxtTocRule>, AppError> {
    with_storage(&state, |storage| storage.list_txt_toc_rules()).await
}

#[tauri::command]
pub async fn save_txt_toc_rule(
    request: SaveTxtTocRuleRequest,
    state: State<'_, AppState>,
) -> Result<TxtTocRule, AppError> {
    with_storage(&state, move |storage| {
        storage.save_txt_toc_rule(&request.rule)
    })
    .await
}

#[tauri::command]
pub async fn delete_txt_toc_rule(
    request: TxtTocRuleIdRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_storage(&state, move |storage| {
        storage.delete_txt_toc_rule(&request.id)
    })
    .await
}

#[tauri::command]
pub async fn order_txt_toc_rules(
    request: OrderTxtTocRulesRequest,
    state: State<'_, AppState>,
) -> Result<Vec<TxtTocRule>, AppError> {
    with_storage(&state, move |storage| {
        storage.order_txt_toc_rules(&request.ids)
    })
    .await
}

#[tauri::command]
pub async fn import_txt_toc_rules(
    request: ImportTxtTocRulesRequest,
    state: State<'_, AppState>,
) -> Result<Vec<TxtTocRule>, AppError> {
    with_storage(&state, move |storage| {
        storage.import_txt_toc_rules(&request.json)
    })
    .await
}

#[tauri::command]
pub async fn export_txt_toc_rules(state: State<'_, AppState>) -> Result<String, AppError> {
    with_storage(&state, |storage| storage.export_txt_toc_rules()).await
}

#[tauri::command]
pub async fn test_txt_toc_rule(request: TestTxtTocRuleRequest) -> Result<Vec<String>, AppError> {
    crate::txt_toc::test_rule(&request.pattern, &request.sample)
}

#[tauri::command]
pub async fn save_book_toc_settings(
    request: SaveBookTocSettingsRequest,
    state: State<'_, AppState>,
) -> Result<BookTocSettings, AppError> {
    with_storage(&state, move |storage| {
        storage.save_book_toc_settings(&request.book_id, &request.settings)
    })
    .await
}

#[tauri::command]
pub async fn import_reader_font(
    request: crate::models::PathRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::models::ReaderAsset, AppError> {
    let root = state.data_root.clone();
    let operation_id = Uuid::new_v4().to_string();
    with_storage(&state, move |storage| {
        let (path, name, _staged) =
            crate::documents::resolve_named_source(&app, &root, &request.path, &operation_id)?;
        storage.import_reader_font(&path, &name)
    })
    .await
}

#[tauri::command]
pub async fn list_reader_fonts(
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::ReaderAsset>, AppError> {
    with_storage(&state, |storage| storage.list_reader_fonts()).await
}

/// Font bytes as a raw IPC response, so the page can load them with FontFace.
#[tauri::command]
pub async fn read_reader_font(
    request: crate::models::ReaderAssetRequest,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, AppError> {
    let bytes = with_storage(&state, move |storage| storage.read_reader_font(&request.id)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn delete_reader_font(
    request: crate::models::ReaderAssetRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_storage(&state, move |storage| {
        storage.delete_reader_font(&request.id)
    })
    .await
}

#[tauri::command]
pub async fn get_book_info(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<BookInfo, AppError> {
    with_storage(&state, move |storage| storage.book_info(&request.book_id)).await
}

#[tauri::command]
pub async fn list_bookmarks(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<Vec<Bookmark>, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .list_bookmarks(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("bookmark worker stopped: {error}")))?
}

#[tauri::command]
pub async fn add_bookmark(
    request: BookmarkRequest,
    state: State<'_, AppState>,
) -> Result<Bookmark, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn delete_bookmark(
    request: BookmarkIdRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .delete_bookmark(&request.bookmark_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("bookmark worker stopped: {error}")))?
}

#[tauri::command]
pub async fn search_book(
    request: SearchRequest,
    state: State<'_, AppState>,
) -> Result<SearchResponse, AppError> {
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
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn cancel_search(
    request: ImportOperationRequest,
    state: State<'_, AppState>,
) -> Result<CancelResult, AppError> {
    let searches = Arc::clone(&state.searches);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn read_content_window(
    request: ReadContentRequest,
    state: State<'_, AppState>,
) -> Result<ContentWindow, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn resolve_reader_locator(
    request: ResolveLocatorRequest,
    state: State<'_, AppState>,
) -> Result<ReaderLocator, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn resolve_reader_offset(
    request: ResolveOffsetRequest,
    state: State<'_, AppState>,
) -> Result<ReaderLocator, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn save_reader_locator(
    request: SaveLocatorRequest,
    state: State<'_, AppState>,
) -> Result<ReaderLocator, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn get_saved_reader_locator(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<Option<ReaderLocator>, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        storage.saved_position(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("position worker stopped: {error}")))?
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<ReaderPreferences, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        storage.get_settings()
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("settings worker stopped: {error}")))?
}

#[tauri::command]
pub async fn save_settings(
    request: SaveSettingsRequest,
    state: State<'_, AppState>,
) -> Result<ReaderPreferences, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
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
    app: &AppHandle,
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
    app: &AppHandle,
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

#[tauri::command]
pub async fn update_book(
    request: crate::models::UpdateBookRequest,
    state: State<'_, AppState>,
) -> Result<crate::models::Book, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .update_book(&request)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
#[tauri::command]
pub async fn remove_book(request: BookRequest, state: State<'_, AppState>) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .remove_book(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
#[tauri::command]
pub async fn restore_book(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .restore_book(&request.book_id)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
#[tauri::command]
pub async fn list_removed_books(state: State<'_, AppState>) -> Result<Vec<LibraryBook>, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .list_removed_books()
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
#[tauri::command]
pub async fn get_shelf_preferences(
    state: State<'_, AppState>,
) -> Result<crate::models::ShelfPreferences, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .get_shelf_preferences()
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
}
#[tauri::command]
pub async fn save_shelf_preferences(
    request: crate::models::SaveShelfPreferencesRequest,
    state: State<'_, AppState>,
) -> Result<crate::models::ShelfPreferences, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .save_shelf_preferences(&request.preferences)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
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

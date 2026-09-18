use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::error::{AppError, ErrorCode};
use crate::models::{
    BookRequest, Bookmark, BookmarkIdRequest, BookmarkRequest, CancelResult, ContentWindow,
    ImportOperationRequest, ImportPhase, ImportResult, ImportStatus, ImportTask, LibraryBook,
    ReadContentRequest, ReaderLocator, ReaderPreferences, ResolveLocatorRequest,
    SaveLocatorRequest, SaveSettingsRequest, SearchRequest, SearchResponse, StartImportRequest,
    TocEntry, TxtDecodeStatus, TxtDecodeTask, TxtEncodingInfo, TxtEncodingRequest,
    TxtSourceRequest,
};
use crate::storage::{
    before_import_commit, build_toc_from_context, duplicate_validation_retry,
    read_content_window_from_context, resolve_locator_from_context, validate_content_locator,
    validate_import_target, verify_content_context, verify_prepared_txt_decode_source, Storage,
};

pub struct AppState {
    pub storage: Arc<Mutex<Storage>>,
    pub data_root: PathBuf,
    imports: Arc<Mutex<HashMap<String, ImportOperation>>>,
    txt_decodes: Arc<Mutex<HashMap<String, TxtDecodeOperation>>>,
    searches: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

struct ImportOperation {
    cancel: Arc<AtomicBool>,
    status: ImportStatus,
}

struct TxtDecodeOperation {
    cancel: Arc<AtomicBool>,
    status: TxtDecodeStatus,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Result<Self, AppError> {
        let storage = Storage::open(&data_dir)?;
        let data_root = storage.root_path().to_path_buf();
        Ok(Self {
            storage: Arc::new(Mutex::new(storage)),
            data_root,
            imports: Arc::new(Mutex::new(HashMap::new())),
            txt_decodes: Arc::new(Mutex::new(HashMap::new())),
            searches: Arc::new(Mutex::new(HashMap::new())),
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
    let worker_operation_id = operation_id.clone();
    let worker_imports = Arc::clone(&imports);
    let source = PathBuf::from(request.path);
    let worker_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let blocking_operation_id = worker_operation_id.clone();
        let blocking_imports = Arc::clone(&worker_imports);
        let blocking_app = worker_app.clone();
        let blocking = tauri::async_runtime::spawn_blocking(move || {
            let prepared = Storage::prepare_import(
                &data_root,
                &source,
                &blocking_operation_id,
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
            Ok(imported) => publish_import_status(
                &worker_imports,
                &worker_app,
                completed_status(&worker_operation_id, imported),
            ),
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
        let prepared = Storage::prepare_txt_reassociation(
            &root,
            &snapshot,
            &PathBuf::from(request.path),
            &operation_id,
        )?;
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
) -> Result<Vec<TocEntry>, AppError> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        let context = {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.content_read_context(&request.book_id)?
        };
        let verified = verify_content_context(&context)?;
        if let Some(entries) = {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.cached_toc(&context)?
        } {
            return Ok(entries);
        }
        let entries = build_toc_from_context(&context, &verified, &request.book_id)?;
        {
            let storage = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            storage.persist_content_index(&context, &verified)?;
            storage.cache_toc(&context, &entries)?;
        }
        Ok(entries)
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("toc worker stopped: {error}")))?
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

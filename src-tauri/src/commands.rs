use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::error::{AppError, ErrorCode};
use crate::models::{
    BookRequest, CancelResult, ContentWindow, ImportOperationRequest, ImportPhase, ImportResult,
    ImportStatus, ImportTask, LibraryBook, ReadContentRequest, ReaderLocator, ReaderPreferences,
    ResolveLocatorRequest, SaveLocatorRequest, SaveSettingsRequest, StartImportRequest,
};
use crate::storage::{
    read_content_window_from_context, resolve_locator_from_context, validate_content_locator,
    validate_import_target, verify_content_context, Storage,
};

pub struct AppState {
    pub storage: Arc<Mutex<Storage>>,
    pub data_root: PathBuf,
    imports: Arc<Mutex<HashMap<String, ImportOperation>>>,
}

struct ImportOperation {
    cancel: Arc<AtomicBool>,
    status: ImportStatus,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Result<Self, AppError> {
        let storage = Storage::open(&data_dir)?;
        let data_root = storage.root_path().to_path_buf();
        Ok(Self {
            storage: Arc::new(Mutex::new(storage)),
            data_root,
            imports: Arc::new(Mutex::new(HashMap::new())),
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
                let target = {
                    let guard = storage.lock().map_err(|_| {
                        AppError::new(ErrorCode::Database, "storage lock is poisoned")
                    })?;
                    guard.snapshot_import_target(&prepared.sha256)?
                };
                let validated_target = target
                    .as_ref()
                    .map(|target| validate_import_target(&data_root, target, &cancel))
                    .transpose()?;
                let mut guard = storage
                    .lock()
                    .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
                guard.commit_import(prepared, &cancel, |_, _, _| {}, validated_target.as_ref())
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

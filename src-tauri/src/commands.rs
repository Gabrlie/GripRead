use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::error::{AppError, ErrorCode};
use crate::models::{
    Book, CancelResult, ContentWindow, ImportPhase, ImportResult, ImportStatus, ImportTask,
    ReaderLocator,
};
use crate::storage::Storage;

pub struct AppState {
    pub storage: Arc<Mutex<Storage>>,
    imports: Arc<Mutex<HashMap<String, ImportOperation>>>,
}

struct ImportOperation {
    cancel: Arc<AtomicBool>,
    status: ImportStatus,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Result<Self, AppError> {
        Ok(Self {
            storage: Arc::new(Mutex::new(Storage::open(&data_dir)?)),
            imports: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

#[tauri::command]
pub fn start_import(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ImportTask, AppError> {
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
                status: initial_status.clone(),
            },
        );

    let storage = Arc::clone(&state.storage);
    let worker_operation_id = operation_id.clone();
    let worker_imports = Arc::clone(&imports);
    let spawn_result = std::thread::Builder::new()
        .name(format!("gripread-import-{operation_id}"))
        .spawn(move || {
            let result = match storage.lock() {
                Ok(mut storage) => storage.import_txt(
                    &PathBuf::from(path),
                    &worker_operation_id,
                    &cancel,
                    |phase, bytes_read, total_bytes| {
                        let status = ImportStatus {
                            operation_id: worker_operation_id.clone(),
                            phase,
                            bytes_read,
                            total_bytes,
                            result: None,
                            error: None,
                        };
                        publish_import_status(&worker_imports, &app, status);
                    },
                ),
                Err(_) => Err(AppError::new(
                    ErrorCode::Database,
                    "storage lock is poisoned",
                )),
            };

            match result {
                Ok(imported) => publish_import_status(
                    &worker_imports,
                    &app,
                    completed_status(&worker_operation_id, imported),
                ),
                Err(error) if error.code == ErrorCode::ImportCancelled => publish_import_status(
                    &worker_imports,
                    &app,
                    terminal_status(
                        &worker_imports,
                        &worker_operation_id,
                        ImportPhase::Cancelled,
                        error,
                    ),
                ),
                Err(error) => publish_import_status(
                    &worker_imports,
                    &app,
                    terminal_status(
                        &worker_imports,
                        &worker_operation_id,
                        ImportPhase::Failed,
                        error,
                    ),
                ),
            }
        });

    if let Err(error) = spawn_result {
        if let Ok(mut operations) = imports.lock() {
            operations.remove(&operation_id);
        }
        return Err(AppError::new(
            ErrorCode::Io,
            format!("unable to start import: {error}"),
        ));
    }

    Ok(ImportTask { operation_id })
}

#[tauri::command]
pub fn get_import_status(
    operation_id: String,
    state: State<'_, AppState>,
) -> Result<ImportStatus, AppError> {
    state
        .imports
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "import state lock is poisoned"))?
        .get(&operation_id)
        .map(|operation| operation.status.clone())
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::OperationNotFound,
                "import operation was not found",
            )
        })
}

#[tauri::command]
pub fn cancel_import(
    operation_id: String,
    state: State<'_, AppState>,
) -> Result<CancelResult, AppError> {
    let imports = state
        .imports
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "import state lock is poisoned"))?;
    let operation = imports.get(&operation_id).ok_or_else(|| {
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
}

#[tauri::command]
pub fn list_books(state: State<'_, AppState>) -> Result<Vec<Book>, AppError> {
    state
        .storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
        .list_books()
}

#[tauri::command]
pub fn read_content_window(
    book_id: String,
    locator: Option<ReaderLocator>,
    max_units: u64,
    state: State<'_, AppState>,
) -> Result<ContentWindow, AppError> {
    state
        .storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
        .read_content_window(&book_id, locator.as_ref(), max_units)
}

#[tauri::command]
pub fn save_reader_locator(
    locator: ReaderLocator,
    state: State<'_, AppState>,
) -> Result<ReaderLocator, AppError> {
    state
        .storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
        .save_position(&locator)
}

#[tauri::command]
pub fn get_saved_reader_locator(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ReaderLocator>, AppError> {
    state
        .storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
        .saved_position(&book_id)
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

fn publish_import_status(
    imports: &Mutex<HashMap<String, ImportOperation>>,
    app: &AppHandle,
    status: ImportStatus,
) {
    if let Ok(mut operations) = imports.lock() {
        if let Some(operation) = operations.get_mut(&status.operation_id) {
            operation.status = status.clone();
        }
    }
    let _ = app.emit("import-progress", status);
}

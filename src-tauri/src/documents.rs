//! Platform document access for imports.
//!
//! Android pickers return `content://` URIs rather than filesystem paths.
//! Storage stays path-based: a document URI is copied into an operation-owned
//! staging directory, named after the document's display name so the title
//! derived from the path is unchanged, and removed when the operation ends.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Runtime};

use crate::error::{AppError, ErrorCode};

const STAGING_DIRECTORY: &str = "document-staging";
const COPY_CHUNK: usize = 64 * 1024;

pub fn is_document_uri(path: &str) -> bool {
    path.starts_with("content://")
}

/// A staged copy whose directory is removed on drop, including on failure.
#[derive(Debug)]
pub struct StagedDocument {
    directory: PathBuf,
    path: PathBuf,
}

impl StagedDocument {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StagedDocument {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.directory) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Unable to remove staged document: {error}");
            }
        }
    }
}

/// Removes copies left behind by a process that ended during staging.
pub fn clear_staging(data_root: &Path) -> Result<(), AppError> {
    match fs::remove_dir_all(data_root.join(STAGING_DIRECTORY)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Resolves a picked source to a readable path. Ordinary paths pass through;
/// document URIs are staged and must stay alive until storage has read them.
pub fn resolve_source<R: Runtime>(
    app: &AppHandle<R>,
    data_root: &Path,
    source: &str,
    operation_id: &str,
    cancel: &AtomicBool,
) -> Result<(PathBuf, Option<StagedDocument>), AppError> {
    if !is_document_uri(source) {
        return Ok((PathBuf::from(source), None));
    }
    let (file, name) = open_document(app, source)?;
    let staged = stage_document(data_root, operation_id, name.as_deref(), file, cancel)?;
    Ok((staged.path().to_path_buf(), Some(staged)))
}

pub fn stage_document(
    data_root: &Path,
    operation_id: &str,
    display_name: Option<&str>,
    mut source: impl Read,
    cancel: &AtomicBool,
) -> Result<StagedDocument, AppError> {
    if operation_id.is_empty() || operation_id.contains(['/', '\\', '.']) {
        return Err(AppError::invalid_argument("invalid staging operation"));
    }
    let directory = data_root.join(STAGING_DIRECTORY).join(operation_id);
    fs::create_dir_all(&directory)?;
    let staged = StagedDocument {
        path: directory.join(staged_file_name(display_name)),
        directory,
    };
    let mut target = File::create(&staged.path)?;
    let mut buffer = vec![0; COPY_CHUNK];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::new(
                ErrorCode::ImportCancelled,
                "TXT import was cancelled",
            ));
        }
        let read = match source.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        };
        target.write_all(&buffer[..read])?;
    }
    target.sync_all()?;
    Ok(staged)
}

/// Keeps the display name as one path component with a `.txt` extension.
fn staged_file_name(display_name: Option<&str>) -> String {
    let name: String = display_name
        .unwrap_or_default()
        .chars()
        .map(|character| match character {
            '/' | '\\' | '\0' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect();
    let name = name.trim();
    let stem = match name
        .len()
        .checked_sub(4)
        .and_then(|start| name.get(start..))
    {
        Some(extension) if extension.eq_ignore_ascii_case(".txt") => &name[..name.len() - 4],
        _ => name,
    };
    // A leading dot would hide the file and is not part of a readable title.
    let stem = stem.trim().trim_start_matches('.').trim();
    // Keep the name within common filesystem limits without splitting a character.
    let stem: String = stem.chars().take(120).collect();
    if stem.is_empty() {
        "Untitled.txt".to_string()
    } else {
        format!("{stem}.txt")
    }
}

#[cfg(target_os = "android")]
fn open_document<R: Runtime>(
    app: &AppHandle<R>,
    uri: &str,
) -> Result<(File, Option<String>), AppError> {
    use std::os::fd::FromRawFd;
    use tauri::Manager;

    #[derive(serde::Serialize)]
    struct Payload<'a> {
        uri: &'a str,
    }
    #[derive(serde::Deserialize)]
    struct Response {
        fd: i32,
        name: Option<String>,
    }
    let plugin = app.state::<DocumentPlugin<R>>();
    let response: Response = plugin
        .0
        .run_mobile_plugin("openDocument", Payload { uri })
        .map_err(|error| AppError::new(ErrorCode::FileNotFound, error.to_string()))?;
    // SAFETY: the Kotlin plugin detaches the descriptor and transfers its
    // ownership to this process; it is closed when the File is dropped.
    let file = unsafe { File::from_raw_fd(response.fd) };
    Ok((file, response.name))
}

#[cfg(not(target_os = "android"))]
fn open_document<R: Runtime>(
    _app: &AppHandle<R>,
    _uri: &str,
) -> Result<(File, Option<String>), AppError> {
    Err(AppError::new(
        ErrorCode::InvalidPath,
        "document URIs are only supported on Android",
    ))
}

#[cfg(target_os = "android")]
struct DocumentPlugin<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// Registers the Android document helper in `gen/android` (`DocumentPlugin.kt`).
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("gripread-documents")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle =
                    _api.register_android_plugin("com.gripread.reader", "DocumentPlugin")?;
                _app.manage(DocumentPlugin(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("gripread-documents-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn stages_bytes_under_the_display_name_and_removes_them_on_drop() {
        let root = TempRoot::new();
        let staged = stage_document(
            &root.0,
            "op-1",
            Some("三体 第一部.txt"),
            Cursor::new(b"\xd6\xd0\xce\xc4".to_vec()),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(staged.path().file_name().unwrap(), "三体 第一部.txt");
        assert_eq!(fs::read(staged.path()).unwrap(), b"\xd6\xd0\xce\xc4");
        drop(staged);
        assert!(!root.0.join(STAGING_DIRECTORY).join("op-1").exists());
    }

    #[test]
    fn cancellation_and_read_failure_leave_no_staged_file() {
        struct Failing;
        impl Read for Failing {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("provider closed"))
            }
        }
        let root = TempRoot::new();
        let cancelled = stage_document(
            &root.0,
            "op-cancel",
            Some("book.txt"),
            Cursor::new(vec![1; 10]),
            &AtomicBool::new(true),
        )
        .unwrap_err();
        assert_eq!(cancelled.code, ErrorCode::ImportCancelled);
        let failed =
            stage_document(&root.0, "op-fail", None, Failing, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(failed.code, ErrorCode::Io);
        let staging = root.0.join(STAGING_DIRECTORY);
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
        clear_staging(&root.0).unwrap();
        assert!(!staging.exists());
    }

    #[test]
    fn display_names_stay_within_one_component() {
        assert_eq!(staged_file_name(Some("../a/b.TXT")), "_a_b.txt");
        assert_eq!(staged_file_name(Some("notes")), "notes.txt");
        assert_eq!(staged_file_name(Some("  .txt ")), "Untitled.txt");
        assert_eq!(staged_file_name(None), "Untitled.txt");
        assert_eq!(staged_file_name(Some("书书")), "书书.txt");
        assert_eq!(staged_file_name(Some("雪中.Txt")), "雪中.txt");
        assert!(stage_document(
            Path::new("/"),
            "../x",
            None,
            Cursor::new(vec![]),
            &AtomicBool::new(false)
        )
        .is_err());
    }
}

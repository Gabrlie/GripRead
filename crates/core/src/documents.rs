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

use crate::error::{AppError, ErrorCode};
use crate::platform::Platform;

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
pub fn resolve_source(
    platform: &dyn Platform,
    data_root: &Path,
    source: &str,
    operation_id: &str,
    cancel: &AtomicBool,
) -> Result<(PathBuf, Option<StagedDocument>), AppError> {
    if !is_document_uri(source) {
        return Ok((PathBuf::from(source), None));
    }
    let (file, name) = platform.open_document(source)?;
    let staged = stage_document(data_root, operation_id, name.as_deref(), file, cancel)?;
    Ok((staged.path().to_path_buf(), Some(staged)))
}

/// Resolves a picked file of any kind, keeping its display name and
/// extension; used for reading fonts.
pub fn resolve_named_source(
    platform: &dyn Platform,
    data_root: &Path,
    source: &str,
    operation_id: &str,
) -> Result<(PathBuf, String, Option<StagedDocument>), AppError> {
    if !is_document_uri(source) {
        let path = PathBuf::from(source);
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Ok((path, name, None));
    }
    let (file, name) = platform.open_document(source)?;
    let name = sanitize_component(name.as_deref().unwrap_or("")).unwrap_or_else(|| "file".into());
    let staged = stage_named(
        data_root,
        operation_id,
        &name,
        file,
        &AtomicBool::new(false),
    )?;
    Ok((staged.path().to_path_buf(), name, Some(staged)))
}

pub fn stage_document(
    data_root: &Path,
    operation_id: &str,
    display_name: Option<&str>,
    source: impl Read,
    cancel: &AtomicBool,
) -> Result<StagedDocument, AppError> {
    stage_named(
        data_root,
        operation_id,
        &staged_file_name(display_name),
        source,
        cancel,
    )
}

fn stage_named(
    data_root: &Path,
    operation_id: &str,
    file_name: &str,
    mut source: impl Read,
    cancel: &AtomicBool,
) -> Result<StagedDocument, AppError> {
    if operation_id.is_empty() || operation_id.contains(['/', '\\', '.']) {
        return Err(AppError::invalid_argument("invalid staging operation"));
    }
    let directory = data_root.join(STAGING_DIRECTORY).join(operation_id);
    fs::create_dir_all(&directory)?;
    let staged = StagedDocument {
        path: directory.join(file_name),
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

/// A display name made safe as one path component, or `None` when nothing is left.
fn sanitize_component(name: &str) -> Option<String> {
    let name: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | '\0' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect();
    let name = name.trim().trim_start_matches('.').trim();
    let name: String = name.chars().take(160).collect();
    (!name.is_empty()).then_some(name)
}

/// Keeps the display name as one path component with a `.txt` extension,
/// or `.epub` for an EPUB.
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
    let ends_with = |suffix: &str| {
        name.len()
            .checked_sub(suffix.len())
            .and_then(|start| name.get(start..))
            .is_some_and(|extension| extension.eq_ignore_ascii_case(suffix))
    };
    let (stem, extension) = if ends_with(".epub") {
        (&name[..name.len() - 5], "epub")
    } else if ends_with(".txt") {
        (&name[..name.len() - 4], "txt")
    } else {
        (name, "txt")
    };
    // A leading dot would hide the file and is not part of a readable title.
    let stem = stem.trim().trim_start_matches('.').trim();
    // Keep the name within common filesystem limits without splitting a character.
    let stem: String = stem.chars().take(120).collect();
    if stem.is_empty() {
        format!("Untitled.{extension}")
    } else {
        format!("{stem}.{extension}")
    }
}

/// TXT files in a folder for batch import (the platform's folder picker on Android).
pub fn list_txt_folder(
    platform: &dyn Platform,
    path: &str,
) -> Result<Vec<crate::models::PickedFile>, AppError> {
    platform.list_txt_folder(path)
}

/// Writes `bytes` to a file the reader chooses; `false` when nothing was chosen.
pub fn save_document(
    platform: &dyn Platform,
    path: Option<&str>,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<bool, AppError> {
    platform.save_document(path, name, mime, bytes)
}

/// Chooses a folder backups can be written to; `None` when cancelled.
pub fn pick_writable_folder(
    platform: &dyn Platform,
    path: Option<&str>,
) -> Result<Option<(String, String)>, AppError> {
    platform.pick_writable_folder(path)
}

/// Writes `name` into a local backup folder: a filesystem path, or on
/// Android a document tree the reader granted (replacing a file of that name).
pub fn write_to_folder(
    platform: &dyn Platform,
    folder: &str,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    if is_document_uri(folder) {
        let mut file = platform.open_tree_document(folder, name, mime)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        return Ok(());
    }
    let directory = Path::new(folder);
    if !directory.is_dir() {
        return Err(AppError::new(
            ErrorCode::InvalidPath,
            "the backup folder was not found",
        ));
    }
    let target = directory.join(name);
    let partial = directory.join(format!("{name}.part"));
    fs::write(&partial, bytes)?;
    fs::rename(&partial, &target)?;
    Ok(())
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
        assert_eq!(staged_file_name(Some("三体.EPUB")), "三体.epub");
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

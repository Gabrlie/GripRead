//! What the core asks of the platform it runs on: opening and writing the
//! documents a reader picks. The defaults use plain filesystem paths (the
//! desktop app and the server); the Android shell answers `content://`
//! documents through its `DocumentPlugin`.

use std::fs::{self, File};
use std::path::Path;

use crate::error::{AppError, ErrorCode};
use crate::models::PickedFile;

pub trait Platform: Send + Sync {
    /// The download queue changed (Android shows its progress notification).
    fn downloads_changed(&self, _jobs: &[crate::models::DownloadJob]) {}

    /// Opens a picked document URI with its display name.
    fn open_document(&self, _uri: &str) -> Result<(File, Option<String>), AppError> {
        Err(AppError::new(
            ErrorCode::InvalidPath,
            "document URIs are only supported on Android",
        ))
    }

    /// Lists `.txt` files in a folder and its subfolders (three levels),
    /// sorted by name. Android shows the system folder picker instead; an
    /// empty list means it was closed.
    fn list_txt_folder(&self, path: &str) -> Result<Vec<PickedFile>, AppError> {
        list_txt_files(Path::new(path))
    }

    /// Writes `bytes` to a file the reader chooses: `path` from the save
    /// dialog, or the system "save as" screen on Android. Returns whether a
    /// file was written (`false` when nothing was chosen).
    fn save_document(
        &self,
        path: Option<&str>,
        _name: &str,
        _mime: &str,
        bytes: &[u8],
    ) -> Result<bool, AppError> {
        let Some(path) = path else {
            return Ok(false);
        };
        let target = Path::new(path);
        let partial = target.with_extension("part");
        fs::write(&partial, bytes)?;
        fs::rename(&partial, target)?;
        Ok(true)
    }

    /// Opens `name` for writing inside a document folder the reader granted.
    fn open_tree_document(&self, _tree: &str, _name: &str, _mime: &str) -> Result<File, AppError> {
        Err(AppError::new(
            ErrorCode::InvalidPath,
            "document folders are only supported on Android",
        ))
    }

    /// Chooses a folder backups can be written to, as its address and a
    /// label; `path` comes from the folder dialog. `None`: cancelled.
    fn pick_writable_folder(
        &self,
        path: Option<&str>,
    ) -> Result<Option<(String, String)>, AppError> {
        let Some(path) = path else {
            return Ok(None);
        };
        if !Path::new(path).is_dir() {
            return Err(AppError::new(
                ErrorCode::InvalidPath,
                "the backup folder was not found",
            ));
        }
        Ok(Some((path.to_string(), path.to_string())))
    }
}

/// Plain filesystem paths.
pub struct Filesystem;

impl Platform for Filesystem {}

fn list_txt_files(root: &Path) -> Result<Vec<PickedFile>, AppError> {
    fn walk(dir: &Path, depth: usize, found: &mut Vec<PickedFile>) -> Result<(), AppError> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if kind.is_dir() && depth < 3 {
                walk(&entry.path(), depth + 1, found)?;
            } else if kind.is_file() && name.to_ascii_lowercase().ends_with(".txt") {
                found.push(PickedFile {
                    path: entry.path().to_string_lossy().to_string(),
                    name,
                });
            }
            if found.len() >= 1000 {
                break;
            }
        }
        Ok(())
    }
    if !root.is_dir() {
        return Err(AppError::new(
            ErrorCode::InvalidPath,
            "the folder was not found",
        ));
    }
    let mut found = Vec::new();
    walk(root, 0, &mut found)?;
    found.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(found)
}

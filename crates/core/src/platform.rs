//! What the core asks of the platform it runs on: opening and writing the
//! documents a reader picks. The defaults use plain filesystem paths (the
//! desktop app and the server); the Android shell answers `content://`
//! documents through its `DocumentPlugin`.

use std::fs::{self, File};
use std::path::{Path, PathBuf};

use crate::error::{AppError, ErrorCode};
use crate::models::PickedFile;

/// The address of a release file by name along an update route.
pub type ArchiveAddress = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Where the desktop updater fetches a release: its manifest
/// (`latest.json`), the address of an archive by file name (the manifest
/// lists GitHub's), and the header and proxy the route needs.
pub struct DesktopUpdate {
    pub manifest: String,
    pub archive: ArchiveAddress,
    pub authorization: Option<String>,
    pub proxy: Option<String>,
}

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

    /// Lists `.txt` and `.epub` files in a folder and its subfolders (three levels),
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

    /// How this copy updates itself; `None` where it does not (the server,
    /// or a desktop platform without published builds).
    fn update_target(&self) -> UpdateTarget {
        UpdateTarget::None
    }

    /// Hands a downloaded APK to the Android installer. `NeedsPermission`
    /// when 安装未知应用 must be allowed first (its settings screen opens).
    fn install_apk(&self, _file: &Path) -> Result<crate::models::InstallOutcome, AppError> {
        Err(AppError::new(
            ErrorCode::InvalidArgument,
            "APKs are only installed on Android",
        ))
    }

    /// Updates the desktop app from a Tauri updater manifest (`latest.json`)
    /// and relaunches it; `progress` gets the bytes received and the total.
    fn install_desktop_update(
        &self,
        _update: &DesktopUpdate,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<(), AppError> {
        Err(AppError::new(
            ErrorCode::InvalidArgument,
            "this platform does not update itself",
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

/// How this copy of GripRead updates itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateTarget {
    None,
    /// Android: the ABIs the device runs, preferred first, and a folder the
    /// installer can read the APK from.
    Android {
        abis: Vec<String>,
        folder: PathBuf,
    },
    /// The desktop updater's platform key in `latest.json`
    /// (`darwin-aarch64`, `darwin-x86_64`).
    Desktop {
        platform: String,
    },
}

/// Plain filesystem paths.
pub struct Filesystem;

impl Platform for Filesystem {}

fn is_book_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".txt") || lower.ends_with(".epub")
}

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
            } else if kind.is_file() && is_book_file(&name) {
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

//! Backups and the cloud bookshelf over WebDAV (Sync specification).
//!
//! Both live under the configured address in `GripRead/`: backups in
//! `Backups/` and book files in `Books/`, each with its own job. A backup
//! never contains books, and uploading a book does not back anything up.
//! Storage is locked only to read or apply records; network transfers run
//! without the lock.

use std::fs::{self, File};
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, ErrorCode};
use crate::models::{CloudBook, CloudUploadReport, PickedFile, RemoteBackup};
use crate::storage::{backup_digest, parse_backup, BackupDocument, Storage, StoredWebDav};
use crate::webdav::{WebDav, BACKUP_FOLDER, BOOK_FOLDER};

/// Automatic backups kept on the server; manual ones are never pruned.
const AUTOMATIC_KEPT: usize = 7;
const DAY_MILLIS: i64 = 24 * 60 * 60 * 1000;
const BACKUP_LIMIT: u64 = 64 * 1024 * 1024;
const INDEX_FILE: &str = "index.json";

fn lock(storage: &Mutex<Storage>) -> Result<std::sync::MutexGuard<'_, Storage>, AppError> {
    storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// `YYYYMMDD-HHMMSS` in UTC.
fn stamp(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let time = seconds.rem_euclid(86_400);
    // Civil date from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        time / 3600,
        time / 60 % 60,
        time % 60
    )
}

pub fn client(settings: &StoredWebDav) -> Result<WebDav, AppError> {
    if !settings.configured() {
        return Err(AppError::invalid_argument("WebDAV is not set up"));
    }
    WebDav::new(&settings.url, &settings.username, &settings.password)
}

fn connect(storage: &Mutex<Storage>) -> Result<WebDav, AppError> {
    let settings = lock(storage)?.stored_webdav()?;
    client(&settings)
}

fn is_backup_name(name: &str) -> bool {
    (name.starts_with("auto-") || name.starts_with("manual-"))
        && name.ends_with(".json")
        && !name.contains(['/', '\\'])
}

/// Uploads the current records as a new backup.
pub fn backup_now(
    storage: &Mutex<Storage>,
    device: &str,
    automatic: bool,
) -> Result<RemoteBackup, AppError> {
    let (dav, document) = {
        let guard = lock(storage)?;
        (
            client(&guard.stored_webdav()?)?,
            guard.export_backup(device)?,
        )
    };
    upload_backup(storage, &dav, &document, automatic)
}

fn upload_backup(
    storage: &Mutex<Storage>,
    dav: &WebDav,
    document: &BackupDocument,
    automatic: bool,
) -> Result<RemoteBackup, AppError> {
    let bytes = serde_json::to_vec(document)?;
    let name = format!(
        "{}-{}.json",
        if automatic { "auto" } else { "manual" },
        stamp(document.created_at)
    );
    dav.create_folder(BACKUP_FOLDER)?;
    dav.put(&format!("{BACKUP_FOLDER}/{name}"), bytes.clone())?;
    if automatic {
        let mut automatic_names: Vec<String> = dav
            .list(BACKUP_FOLDER)?
            .into_iter()
            .filter(|entry| !entry.directory && entry.name.starts_with("auto-"))
            .map(|entry| entry.name)
            .collect();
        automatic_names.sort();
        while automatic_names.len() > AUTOMATIC_KEPT {
            let oldest = automatic_names.remove(0);
            dav.delete(&format!("{BACKUP_FOLDER}/{oldest}"))?;
        }
    }
    let guard = lock(storage)?;
    let mut settings = guard.stored_webdav()?;
    settings.last_backup_at = Some(document.created_at);
    settings.last_error = None;
    if automatic {
        settings.last_backup_digest = Some(backup_digest(document)?);
    }
    guard.save_stored_webdav(&settings)?;
    Ok(RemoteBackup {
        name,
        size: bytes.len() as u64,
        modified: Some(document.created_at),
        automatic,
    })
}

/// The daily automatic backup: runs when it is enabled, a day has passed
/// since the last backup, and the records changed. A failure is kept for
/// the settings page instead of interrupting reading.
pub fn automatic_backup(
    storage: &Mutex<Storage>,
    device: &str,
) -> Result<Option<RemoteBackup>, AppError> {
    let (settings, document) = {
        let guard = lock(storage)?;
        let settings = guard.stored_webdav()?;
        if !settings.configured() || !settings.auto_backup {
            return Ok(None);
        }
        if settings
            .last_backup_at
            .is_some_and(|last| now_millis() - last < DAY_MILLIS)
        {
            return Ok(None);
        }
        let document = guard.export_backup(device)?;
        if settings.last_backup_digest.as_deref() == Some(backup_digest(&document)?.as_str()) {
            return Ok(None);
        }
        (settings, document)
    };
    let result = client(&settings).and_then(|dav| upload_backup(storage, &dav, &document, true));
    match result {
        Ok(backup) => Ok(Some(backup)),
        Err(error) => {
            let guard = lock(storage)?;
            let mut settings = guard.stored_webdav()?;
            settings.last_error = Some(error.message.clone());
            guard.save_stored_webdav(&settings)?;
            Err(error)
        }
    }
}

/// Backups on the server, newest first.
pub fn list_backups(storage: &Mutex<Storage>) -> Result<Vec<RemoteBackup>, AppError> {
    let dav = connect(storage)?;
    let mut backups: Vec<RemoteBackup> = dav
        .list(BACKUP_FOLDER)?
        .into_iter()
        .filter(|entry| !entry.directory && is_backup_name(&entry.name))
        .map(|entry| RemoteBackup {
            automatic: entry.name.starts_with("auto-"),
            name: entry.name,
            size: entry.size,
            modified: entry.modified,
        })
        .collect();
    // Names end in a sortable time stamp after their kind.
    backups.sort_by(|left, right| {
        let key = |name: &str| name.split_once('-').map(|(_, rest)| rest.to_string());
        key(&right.name).cmp(&key(&left.name))
    });
    Ok(backups)
}

pub fn fetch_backup(storage: &Mutex<Storage>, name: &str) -> Result<BackupDocument, AppError> {
    if !is_backup_name(name) {
        return Err(AppError::invalid_argument("unknown backup"));
    }
    let dav = connect(storage)?;
    parse_backup(&dav.download_bytes(&format!("{BACKUP_FOLDER}/{name}"), BACKUP_LIMIT)?)
}

pub fn delete_backup(storage: &Mutex<Storage>, name: &str) -> Result<(), AppError> {
    if !is_backup_name(name) {
        return Err(AppError::invalid_argument("unknown backup"));
    }
    connect(storage)?.delete(&format!("{BACKUP_FOLDER}/{name}"))
}

/// The cloud book folder's index: who uploaded which file, with its hash.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct BookIndex {
    version: u32,
    books: Vec<IndexedBook>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct IndexedBook {
    name: String,
    source_sha256: String,
    title: String,
    #[serde(default)]
    author: Option<String>,
    size: u64,
    uploaded_at: i64,
}

fn read_index(dav: &WebDav) -> Result<BookIndex, AppError> {
    if !dav.exists(&format!("{BOOK_FOLDER}/{INDEX_FILE}"))? {
        return Ok(BookIndex::default());
    }
    let bytes = dav.download_bytes(&format!("{BOOK_FOLDER}/{INDEX_FILE}"), 16 * 1024 * 1024)?;
    // An unreadable index is rebuilt from the uploads that follow.
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn write_index(dav: &WebDav, index: &BookIndex) -> Result<(), AppError> {
    let mut index = index.clone();
    index.version = 1;
    dav.put(
        &format!("{BOOK_FOLDER}/{INDEX_FILE}"),
        serde_json::to_vec_pretty(&index)?,
    )
}

/// A file name for a book title, without characters servers reject.
fn file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|character| {
            if r#"/\:*?"<>|"#.contains(character) || character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    let cleaned: String = cleaned.chars().take(80).collect();
    if cleaned.is_empty() {
        "book".into()
    } else {
        cleaned
    }
}

fn title_of(name: &str) -> String {
    name.strip_suffix(".txt")
        .or_else(|| name.strip_suffix(".TXT"))
        .unwrap_or(name)
        .to_string()
}

/// TXT files in the cloud book folder, with what the index knows of them
/// and the local book that has the same file.
pub fn list_cloud_books(storage: &Mutex<Storage>) -> Result<Vec<CloudBook>, AppError> {
    let dav = connect(storage)?;
    let index = read_index(&dav)?;
    let entries = dav.list(BOOK_FOLDER)?;
    let guard = lock(storage)?;
    let mut books = Vec::new();
    for entry in entries {
        if entry.directory || !entry.name.to_ascii_lowercase().ends_with(".txt") {
            continue;
        }
        let indexed = index.books.iter().find(|book| book.name == entry.name);
        let local_book_id = match indexed {
            Some(book) => guard.book_for_source(&book.source_sha256)?,
            None => None,
        };
        books.push(CloudBook {
            title: indexed.map_or_else(|| title_of(&entry.name), |book| book.title.clone()),
            author: indexed.and_then(|book| book.author.clone()),
            size: entry.size,
            source_sha256: indexed.map(|book| book.source_sha256.clone()),
            uploaded_at: indexed.map(|book| book.uploaded_at).or(entry.modified),
            local_book_id,
            name: entry.name,
        });
    }
    books.sort_by_key(|book| std::cmp::Reverse(book.uploaded_at));
    Ok(books)
}

/// Uploads the original files of `book_ids` (every shelf book when empty)
/// that are not on the cloud bookshelf yet.
pub fn upload_books(
    storage: &Mutex<Storage>,
    book_ids: &[String],
) -> Result<CloudUploadReport, AppError> {
    let dav = connect(storage)?;
    dav.create_folder(BOOK_FOLDER)?;
    let mut index = read_index(&dav)?;
    let names: std::collections::HashSet<String> = dav
        .list(BOOK_FOLDER)?
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    let ids: Vec<String> = if book_ids.is_empty() {
        lock(storage)?
            .shelf_sources()?
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    } else {
        book_ids.to_vec()
    };
    let mut report = CloudUploadReport::default();
    for id in ids {
        let source = {
            let guard = lock(storage)?;
            guard.book_source_file(&id).and_then(|(path, hash, title)| {
                let author = guard.get_book(&id)?.author;
                Ok((path, hash, title, author))
            })
        };
        let (path, hash, title, author) = match source {
            Ok(source) => source,
            Err(error) => {
                report.failed.push(format!("{id}: {}", error.message));
                continue;
            }
        };
        if index
            .books
            .iter()
            .any(|book| book.source_sha256 == hash && names.contains(&book.name))
        {
            report.skipped += 1;
            continue;
        }
        let base = file_name(&title);
        let taken =
            |name: &str| names.contains(name) || index.books.iter().any(|book| book.name == name);
        let name = if taken(&format!("{base}.txt")) {
            format!("{base}-{}.txt", &hash[..8.min(hash.len())])
        } else {
            format!("{base}.txt")
        };
        let size = fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        match File::open(&path)
            .map_err(AppError::from)
            .and_then(|file| dav.put(&format!("{BOOK_FOLDER}/{name}"), file))
        {
            Ok(()) => {
                index
                    .books
                    .retain(|book| book.name != name && book.source_sha256 != hash);
                index.books.push(IndexedBook {
                    name,
                    source_sha256: hash,
                    title: title.clone(),
                    author,
                    size,
                    uploaded_at: now_millis(),
                });
                report.uploaded += 1;
                // Keep the index current, so an interrupted batch loses nothing.
                write_index(&dav, &index)?;
            }
            Err(error) => report.failed.push(format!("{title}: {}", error.message)),
        }
    }
    Ok(report)
}

/// Downloads a cloud book completely into a staging folder, named by its
/// title, for the ordinary import (which matches it to a book with the
/// same file instead of adding a second copy).
pub fn download_cloud_book(
    storage: &Mutex<Storage>,
    data_root: &Path,
    name: &str,
) -> Result<PickedFile, AppError> {
    if name.contains(['/', '\\']) || !name.to_ascii_lowercase().ends_with(".txt") {
        return Err(AppError::invalid_argument("unknown cloud book"));
    }
    let dav = connect(storage)?;
    let index = read_index(&dav)?;
    let title = index
        .books
        .iter()
        .find(|book| book.name == name)
        .map_or_else(|| title_of(name), |book| book.title.clone());
    let directory = data_root
        .join("document-staging")
        .join(format!("cloud-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory)?;
    let file_name = format!("{}.txt", file_name(&title));
    let path = directory.join(&file_name);
    let partial = directory.join(format!("{file_name}.part"));
    let result = (|| {
        let mut file = File::create(&partial)?;
        dav.download(&format!("{BOOK_FOLDER}/{name}"), &mut file)?;
        file.sync_all()?;
        fs::rename(&partial, &path)?;
        Ok::<_, AppError>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&directory);
        return Err(error);
    }
    Ok(PickedFile {
        path: path.to_string_lossy().into_owned(),
        name: file_name,
    })
}

pub fn delete_cloud_book(storage: &Mutex<Storage>, name: &str) -> Result<(), AppError> {
    if name.contains(['/', '\\']) || name == INDEX_FILE {
        return Err(AppError::invalid_argument("unknown cloud book"));
    }
    let dav = connect(storage)?;
    dav.delete(&format!("{BOOK_FOLDER}/{name}"))?;
    let mut index = read_index(&dav)?;
    let before = index.books.len();
    index.books.retain(|book| book.name != name);
    if index.books.len() != before {
        write_index(&dav, &index)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_server {
    //! A minimal in-memory WebDAV server for exercising the client.
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    pub struct Server {
        pub url: String,
        pub files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    }

    fn decode(path: &str) -> String {
        let bytes = path.as_bytes();
        let mut out = Vec::new();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' && index + 2 < bytes.len() {
                out.push(u8::from_str_radix(&path[index + 1..index + 3], 16).unwrap());
                index += 3;
            } else {
                out.push(bytes[index]);
                index += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }

    /// Serves `/dav/` for `user`/`pass`; folders are paths ending in `/`.
    pub fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/dav/", listener.local_addr().unwrap());
        let files: Arc<Mutex<BTreeMap<String, Vec<u8>>>> = Arc::default();
        files.lock().unwrap().insert("/dav/".into(), Vec::new());
        let shared = Arc::clone(&files);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = decode(parts.next().unwrap_or("/"));
                let mut headers = BTreeMap::new();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
                    }
                }
                let mut body = Vec::new();
                if let Some(length) = headers.get("content-length") {
                    body.resize(length.parse().unwrap(), 0);
                    reader.read_exact(&mut body).unwrap();
                } else if headers
                    .get("transfer-encoding")
                    .is_some_and(|v| v.contains("chunked"))
                {
                    loop {
                        let mut size = String::new();
                        reader.read_line(&mut size).unwrap();
                        let size = usize::from_str_radix(size.trim(), 16).unwrap();
                        let mut chunk = vec![0; size + 2];
                        reader.read_exact(&mut chunk).unwrap();
                        if size == 0 {
                            break;
                        }
                        body.extend_from_slice(&chunk[..size]);
                    }
                }
                let mut files = shared.lock().unwrap();
                let (status, payload) = if headers.get("authorization").map(String::as_str)
                    != Some("Basic dXNlcjpwYXNz")
                {
                    (401, Vec::new())
                } else {
                    match method.as_str() {
                        "MKCOL" => {
                            let folder = if path.ends_with('/') {
                                path.clone()
                            } else {
                                format!("{path}/")
                            };
                            match files.entry(folder) {
                                std::collections::btree_map::Entry::Occupied(_) => {
                                    (405, Vec::new())
                                }
                                std::collections::btree_map::Entry::Vacant(slot) => {
                                    slot.insert(Vec::new());
                                    (201, Vec::new())
                                }
                            }
                        }
                        "PUT" => {
                            files.insert(path, body);
                            (201, Vec::new())
                        }
                        "GET" => match files.get(&path) {
                            Some(bytes) => (200, bytes.clone()),
                            None => (404, Vec::new()),
                        },
                        "DELETE" => (
                            if files.remove(&path).is_some() {
                                204
                            } else {
                                404
                            },
                            Vec::new(),
                        ),
                        "PROPFIND" => {
                            let folder = if path.ends_with('/') {
                                path.clone()
                            } else {
                                format!("{path}/")
                            };
                            if headers.get("depth").map(String::as_str) == Some("0") {
                                let found =
                                    files.contains_key(&path) || files.contains_key(&folder);
                                (
                                    if found { 207 } else { 404 },
                                    b"<multistatus xmlns=\"DAV:\"/>".to_vec(),
                                )
                            } else if !files.contains_key(&folder) {
                                (404, Vec::new())
                            } else {
                                let mut xml = String::from(
                                    "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\">",
                                );
                                xml.push_str(&format!("<d:response><d:href>{folder}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>"));
                                for (name, bytes) in files.iter() {
                                    let Some(rest) = name.strip_prefix(&folder) else {
                                        continue;
                                    };
                                    let rest = rest.trim_end_matches('/');
                                    if rest.is_empty() || rest.contains('/') {
                                        continue;
                                    }
                                    let kind = if name.ends_with('/') {
                                        "<d:collection/>"
                                    } else {
                                        ""
                                    };
                                    xml.push_str(&format!("<d:response><d:href>{name}</d:href><d:propstat><d:prop><d:resourcetype>{kind}</d:resourcetype><d:getcontentlength>{}</d:getcontentlength></d:prop></d:propstat></d:response>", bytes.len()));
                                }
                                xml.push_str("</d:multistatus>");
                                (207, xml.into_bytes())
                            }
                        }
                        _ => (405, Vec::new()),
                    }
                };
                drop(files);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(&payload);
            }
        });
        Server { url, files }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected(root: &Path, url: &str) -> Mutex<Storage> {
        let storage = Storage::open(root).unwrap();
        storage
            .save_stored_webdav(&StoredWebDav {
                url: url.into(),
                username: "user".into(),
                password: "pass".into(),
                auto_backup: true,
                ..StoredWebDav::default()
            })
            .unwrap();
        Mutex::new(storage)
    }

    fn import(storage: &Mutex<Storage>, path: &Path) -> String {
        lock(storage)
            .unwrap()
            .import_txt(
                path,
                &Uuid::new_v4().to_string(),
                &std::sync::atomic::AtomicBool::new(false),
                |_, _, _| {},
            )
            .unwrap()
            .book
            .id
    }

    #[test]
    fn backups_and_the_cloud_bookshelf_over_webdav() {
        let server = test_server::start();
        let root = std::env::temp_dir().join(format!("gripread-cloud-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("云海问道.txt");
        fs::write(&source, "第一章\n山门前的石阶。".as_bytes()).unwrap();
        let first = connected(&root.join("first"), &server.url);
        let book = import(&first, &source);

        // A wrong password is reported as such.
        let mut wrong = lock(&first).unwrap().stored_webdav().unwrap();
        wrong.password = "nope".into();
        assert!(client(&wrong)
            .unwrap()
            .check()
            .unwrap_err()
            .message
            .contains("401"));
        client(&lock(&first).unwrap().stored_webdav().unwrap())
            .unwrap()
            .check()
            .unwrap();

        // Manual backups stay; automatic ones are kept to seven.
        let manual = backup_now(&first, "Linux", false).unwrap();
        assert!(manual.name.starts_with("manual-"));
        let dav = connect(&first).unwrap();
        for day in 0..9 {
            let mut document = lock(&first).unwrap().export_backup("Linux").unwrap();
            document.created_at = 1_791_705_600_000 + day * DAY_MILLIS;
            upload_backup(&first, &dav, &document, true).unwrap();
        }
        let backups = list_backups(&first).unwrap();
        assert_eq!(backups.iter().filter(|backup| backup.automatic).count(), 7);
        assert_eq!(backups.iter().filter(|backup| !backup.automatic).count(), 1);
        assert_eq!(fetch_backup(&first, &manual.name).unwrap().books.len(), 1);
        // Today's automatic backup is done, and unchanged records are not uploaded again.
        assert!(automatic_backup(&first, "Linux").unwrap().is_none());
        delete_backup(&first, &manual.name).unwrap();
        assert!(list_backups(&first)
            .unwrap()
            .iter()
            .all(|backup| backup.automatic));
        assert!(fetch_backup(&first, "../secret").is_err());

        // Uploading twice stores the file once; the listing knows it is local.
        let report = upload_books(&first, &[]).unwrap();
        assert_eq!((report.uploaded, report.skipped), (1, 0));
        assert_eq!(
            upload_books(&first, std::slice::from_ref(&book))
                .unwrap()
                .skipped,
            1
        );
        let cloud = list_cloud_books(&first).unwrap();
        assert_eq!(cloud.len(), 1);
        assert_eq!(cloud[0].name, "云海问道.txt");
        assert_eq!(cloud[0].local_book_id.as_deref(), Some(book.as_str()));

        // Another device pulls the whole file and imports it.
        let second = connected(&root.join("second"), &server.url);
        let listed = list_cloud_books(&second).unwrap();
        assert_eq!(listed[0].local_book_id, None);
        let pulled = download_cloud_book(&second, &root.join("second"), &listed[0].name).unwrap();
        assert_eq!(pulled.name, "云海问道.txt");
        let pulled_id = import(&second, Path::new(&pulled.path));
        assert_eq!(
            list_cloud_books(&second).unwrap()[0]
                .local_book_id
                .as_deref(),
            Some(pulled_id.as_str())
        );
        // Pulling again matches the same book instead of adding a copy.
        let again = download_cloud_book(&second, &root.join("second"), &listed[0].name).unwrap();
        assert_eq!(import(&second, Path::new(&again.path)), pulled_id);

        delete_cloud_book(&second, &listed[0].name).unwrap();
        assert!(list_cloud_books(&first).unwrap().is_empty());
        assert!(!String::from_utf8(
            server
                .files
                .lock()
                .unwrap()
                .get("/dav/GripRead/Books/index.json")
                .unwrap()
                .clone()
        )
        .unwrap()
        .contains("云海问道.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn names_and_stamps() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_791_705_600_000), "20261011-080000");
        assert_eq!(file_name(" 云海/问道: 第一卷? "), "云海_问道_ 第一卷_");
        assert_eq!(file_name("..."), "book");
        assert_eq!(title_of("云海.txt"), "云海");
        assert!(is_backup_name("auto-20261011-080000.json"));
        assert!(!is_backup_name("../auto-1.json"));
        assert!(!is_backup_name("recovery-1.json"));
    }
}

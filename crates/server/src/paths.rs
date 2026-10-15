//! Files on the server are only what the reader uploaded. A command's file
//! fields (`path`, or a backup file source) must be an `upload:<id>/<name>`
//! token from `/api/upload`, which becomes that file's path here; any other
//! path is refused, so a request cannot read or write elsewhere on the host.

use gripread_core::error::{AppError, ErrorCode};
use serde_json::Value;
use std::path::Path;

const PREFIX: &str = "upload:";

pub fn token(id: &str, name: &str) -> String {
    format!("{PREFIX}{id}/{name}")
}

/// An uploaded file's name kept as one safe path component.
pub fn file_name(name: &str) -> String {
    let name: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect();
    let name = name.trim().trim_start_matches('.').trim();
    let name: String = name.chars().take(160).collect();
    if name.is_empty() {
        "file".into()
    } else {
        name
    }
}

fn resolve(token: &str, uploads: &Path) -> Result<String, AppError> {
    let refused = || {
        AppError::keyed(
            ErrorCode::InvalidArgument,
            "uploadsOnly",
            "服务器上只能使用上传的文件",
        )
    };
    let rest = token.strip_prefix(PREFIX).ok_or_else(refused)?;
    let (id, name) = rest.split_once('/').ok_or_else(refused)?;
    if uuid::Uuid::parse_str(id).is_err() || name != file_name(name) {
        return Err(refused());
    }
    Ok(uploads.join(id).join(name).to_string_lossy().into_owned())
}

/// Checks and rewrites the file fields of a command's arguments in place.
pub fn admit(args: &mut Value, uploads: &Path) -> Result<(), AppError> {
    match args {
        Value::Object(map) => {
            // A backup source picked from a file: `{ kind: "file", name }`.
            if map.get("kind").and_then(Value::as_str) == Some("file") {
                if let Some(Value::String(name)) = map.get_mut("name") {
                    *name = resolve(name, uploads)?;
                }
            }
            for (key, value) in map.iter_mut() {
                match (key.as_str(), value) {
                    ("path", Value::String(path)) if !path.is_empty() => {
                        *path = resolve(path, uploads)?;
                    }
                    ("paths", Value::Array(paths)) => {
                        for path in paths {
                            if let Value::String(path) = path {
                                *path = resolve(path, uploads)?;
                            }
                        }
                    }
                    (_, value) => admit(value, uploads)?,
                }
            }
            Ok(())
        }
        Value::Array(items) => items.iter_mut().try_for_each(|item| admit(item, uploads)),
        _ => Ok(()),
    }
}

/// RFC 5987 encoding for a download's file name.
pub fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_uploads_reach_commands() {
        let uploads = Path::new("/data/uploads");
        let id = "0d4b8a52-6f3c-4b6e-9a51-1f2e3d4c5b6a";
        let mut args = json!({ "request": { "path": token(id, "三体.txt"), "encoding": "gbk" } });
        admit(&mut args, uploads).unwrap();
        assert_eq!(
            args["request"]["path"],
            format!("/data/uploads/{id}/三体.txt")
        );

        for path in [
            "/etc/passwd",
            "upload:../../etc/passwd",
            &format!("upload:{id}/../x"),
            "C:\\x",
        ] {
            let mut args = json!({ "request": { "path": path } });
            assert!(admit(&mut args, uploads).is_err(), "{path}");
        }
        let mut backup =
            json!({ "request": { "source": { "kind": "file", "name": "/root/x.json" } } });
        assert!(admit(&mut backup, uploads).is_err());
        let mut remote = json!({ "request": { "source": { "kind": "remote", "name": "a.json" } } });
        admit(&mut remote, uploads).unwrap();
        // An empty or absent path asks for no file (an export to download).
        let mut export = json!({ "request": { "path": "", "urls": ["https://a.com"] } });
        admit(&mut export, uploads).unwrap();
    }

    #[test]
    fn names_stay_one_component() {
        assert_eq!(file_name("../../a.txt"), "a.txt");
        assert_eq!(file_name("C:\\books\\b.txt"), "b.txt");
        assert_eq!(file_name(".hidden"), "hidden");
        assert_eq!(file_name(""), "file");
        assert_eq!(percent_encode("备份 1.json"), "%E5%A4%87%E4%BB%BD%201.json");
    }
}

//! A small WebDAV client for backups and the cloud bookshelf (Sync
//! specification). It needs PROPFIND (depth 1), MKCOL, GET, PUT, and DELETE
//! with basic authentication, as Legado uses with 坚果云 and similar servers.

use std::io::{Read, Write};
use std::time::Duration;

use regex::Regex;
use ureq::http::{Method, Request};

use crate::error::{AppError, ErrorCode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEntry {
    /// The entry's name inside the listed folder.
    pub name: String,
    pub directory: bool,
    pub size: u64,
    /// Last modification as epoch milliseconds, when the server reports it.
    pub modified: Option<i64>,
}

pub struct WebDav {
    base: String,
    authorization: String,
    agent: ureq::Agent,
}

fn network_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("WebDAV request failed: {error}"))
}

fn status_error(status: u16, action: &str) -> AppError {
    let reason = match status {
        401 | 403 => "the account or password was rejected",
        404 => "the address was not found",
        405 => "the server does not allow this operation",
        507 => "the server has no space left",
        _ => "the server returned an error",
    };
    AppError::new(
        if status == 401 || status == 403 {
            ErrorCode::InvalidArgument
        } else {
            ErrorCode::Io
        },
        format!("WebDAV {action} failed ({status}): {reason}"),
    )
}

impl WebDav {
    pub fn new(url: &str, username: &str, password: &str) -> Result<Self, AppError> {
        let url = url.trim();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(AppError::invalid_argument(
                "the WebDAV address must start with https:// or http://",
            ));
        }
        let base = if url.ends_with('/') {
            url.to_string()
        } else {
            format!("{url}/")
        };
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .allow_non_standard_methods(true)
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .build()
            .into();
        Ok(Self {
            base,
            authorization: format!(
                "Basic {}",
                base64(format!("{username}:{password}").as_bytes())
            ),
            agent,
        })
    }

    /// The address of `path` (slash-separated, relative to the base), with
    /// each segment percent-encoded.
    fn url(&self, path: &str, directory: bool) -> String {
        let encoded: Vec<String> = path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(encode_segment)
            .collect();
        let mut url = format!("{}{}", self.base, encoded.join("/"));
        if directory && !url.ends_with('/') {
            url.push('/');
        }
        url
    }

    fn request(&self, method: &str, url: &str) -> ureq::http::request::Builder {
        Request::builder()
            .method(Method::from_bytes(method.as_bytes()).expect("WebDAV method names are valid"))
            .uri(url)
            .header("Authorization", &self.authorization)
    }

    /// Lists a folder; a missing folder lists as empty.
    pub fn list(&self, folder: &str) -> Result<Vec<RemoteEntry>, AppError> {
        let body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;
        let request = self
            .request("PROPFIND", &self.url(folder, true))
            .header("Depth", "1")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body)
            .map_err(network_error)?;
        let mut response = self.agent.run(request).map_err(network_error)?;
        let status = response.status().as_u16();
        if status == 404 {
            return Ok(Vec::new());
        }
        if status != 207 && status != 200 {
            return Err(status_error(status, "listing"));
        }
        let xml = response
            .body_mut()
            .with_config()
            .limit(8 * 1024 * 1024)
            .read_to_string()
            .map_err(network_error)?;
        Ok(parse_multistatus(&xml, &self.url(folder, true)))
    }

    /// Checks the address and account by listing the base folder.
    pub fn check(&self) -> Result<(), AppError> {
        let request = self
            .request("PROPFIND", &self.base)
            .header("Depth", "0")
            .body(())
            .map_err(network_error)?;
        let status = self
            .agent
            .run(request)
            .map_err(network_error)?
            .status()
            .as_u16();
        if status == 207 || status == 200 {
            Ok(())
        } else {
            Err(status_error(status, "connection check"))
        }
    }

    /// Creates `folder` and its parents; existing folders are fine.
    pub fn create_folder(&self, folder: &str) -> Result<(), AppError> {
        let mut path = String::new();
        for segment in folder.split('/').filter(|segment| !segment.is_empty()) {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(segment);
            let request = self
                .request("MKCOL", &self.url(&path, true))
                .body(())
                .map_err(network_error)?;
            let status = self
                .agent
                .run(request)
                .map_err(network_error)?
                .status()
                .as_u16();
            // 405: the folder exists; some servers answer 409 or 301 for that too.
            if !(200..300).contains(&status) && status != 405 && status != 301 {
                return Err(status_error(status, "creating a folder"));
            }
        }
        Ok(())
    }

    pub fn put(&self, path: &str, body: impl ureq::AsSendBody) -> Result<(), AppError> {
        let request = self
            .request("PUT", &self.url(path, false))
            .body(body)
            .map_err(network_error)?;
        let status = self
            .agent
            .run(request)
            .map_err(network_error)?
            .status()
            .as_u16();
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(status_error(status, "upload"))
        }
    }

    /// Downloads `path` into `target`, returning the byte count.
    pub fn download(&self, path: &str, target: &mut impl Write) -> Result<u64, AppError> {
        let request = self
            .request("GET", &self.url(path, false))
            .body(())
            .map_err(network_error)?;
        let mut response = self.agent.run(request).map_err(network_error)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(status_error(status, "download"));
        }
        let mut reader = response.body_mut().with_config().limit(u64::MAX).reader();
        std::io::copy(&mut reader, target).map_err(network_error)
    }

    pub fn download_bytes(&self, path: &str, limit: u64) -> Result<Vec<u8>, AppError> {
        let mut bytes = Vec::new();
        let request = self
            .request("GET", &self.url(path, false))
            .body(())
            .map_err(network_error)?;
        let mut response = self.agent.run(request).map_err(network_error)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(status_error(status, "download"));
        }
        response
            .body_mut()
            .with_config()
            .limit(limit)
            .reader()
            .read_to_end(&mut bytes)
            .map_err(network_error)?;
        Ok(bytes)
    }

    /// Whether `path` exists (404 means no).
    pub fn exists(&self, path: &str) -> Result<bool, AppError> {
        let request = self
            .request("PROPFIND", &self.url(path, false))
            .header("Depth", "0")
            .body(())
            .map_err(network_error)?;
        let status = self
            .agent
            .run(request)
            .map_err(network_error)?
            .status()
            .as_u16();
        match status {
            404 => Ok(false),
            200..=299 => Ok(true),
            _ => Err(status_error(status, "lookup")),
        }
    }

    pub fn delete(&self, path: &str) -> Result<(), AppError> {
        let request = self
            .request("DELETE", &self.url(path, false))
            .body(())
            .map_err(network_error)?;
        let status = self
            .agent
            .run(request)
            .map_err(network_error)?
            .status()
            .as_u16();
        if (200..300).contains(&status) || status == 404 {
            Ok(())
        } else {
            Err(status_error(status, "delete"))
        }
    }
}

fn encode_segment(segment: &str) -> String {
    let mut encoded = String::new();
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn decode_percent(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn unescape_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Reads a PROPFIND multistatus response, whatever namespace prefix the
/// server uses, and returns the children of `folder_url` (not the folder).
pub fn parse_multistatus(xml: &str, folder_url: &str) -> Vec<RemoteEntry> {
    let tag = |name: &str| {
        Regex::new(&format!(
            r"(?s)<(?:[A-Za-z0-9_]+:)?{name}(?:\s[^>]*)?>(.*?)</(?:[A-Za-z0-9_]+:)?{name}\s*>"
        ))
        .expect("tag patterns are valid")
    };
    let response = tag("response");
    let href = tag("href");
    let length = tag("getcontentlength");
    let modified = tag("getlastmodified");
    let collection =
        Regex::new(r"<(?:[A-Za-z0-9_]+:)?collection\s*/?>").expect("collection pattern is valid");
    let folder_path = path_of(folder_url);
    let mut entries = Vec::new();
    for block in response.captures_iter(xml) {
        let block = &block[1];
        let Some(href) = href
            .captures(block)
            .map(|value| unescape_xml(value[1].trim()))
        else {
            continue;
        };
        let path = decode_percent(&path_of(&href));
        if path.trim_end_matches('/') == decode_percent(&folder_path).trim_end_matches('/') {
            continue;
        }
        let name = path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();
        if name.is_empty() {
            continue;
        }
        entries.push(RemoteEntry {
            name,
            directory: collection.is_match(block),
            size: length
                .captures(block)
                .and_then(|value| value[1].trim().parse().ok())
                .unwrap_or(0),
            modified: modified
                .captures(block)
                .and_then(|value| parse_http_date(value[1].trim())),
        });
    }
    entries
}

/// The path part of an absolute or server-relative address.
fn path_of(href: &str) -> String {
    match href.find("://") {
        Some(scheme) => {
            let rest = &href[scheme + 3..];
            rest.find('/')
                .map_or("/".to_string(), |slash| rest[slash..].to_string())
        }
        None => href.to_string(),
    }
}

/// RFC 1123 dates such as `Sun, 11 Oct 2026 08:00:00 GMT`.
pub fn parse_http_date(value: &str) -> Option<i64> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|name| *name == parts[2])? as i64
        + 1;
    let year: i64 = parts[3].parse().ok()?;
    let time: Vec<i64> = parts[4]
        .split(':')
        .filter_map(|part| part.parse().ok())
        .collect();
    if time.len() != 3 {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + time[0]) * 60 + time[1]) * 60_000 + time[2] * 1000)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                output.push(TABLE[((value >> (18 - index * 6)) & 63) as usize] as char);
            } else {
                output.push('=');
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multistatus_lists_children_with_any_prefix() {
        let xml = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
 <D:response><D:href>/dav/GripRead/Books/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
 <D:response><D:href>/dav/GripRead/Books/%E4%BA%91%E6%B5%B7.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>1234</D:getcontentlength><D:getlastmodified>Sun, 11 Oct 2026 08:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>
 <D:response><D:href>https://dav.example.com/dav/GripRead/Books/old/</D:href><D:propstat><D:prop><D:resourcetype><D:collection /></D:resourcetype></D:prop></D:propstat></D:response>
</D:multistatus>"#;
        let entries = parse_multistatus(xml, "https://dav.example.com/dav/GripRead/Books/");
        assert_eq!(
            entries,
            vec![
                RemoteEntry {
                    name: "云海.txt".into(),
                    directory: false,
                    size: 1234,
                    modified: Some(1_791_705_600_000),
                },
                RemoteEntry {
                    name: "old".into(),
                    directory: true,
                    size: 0,
                    modified: None,
                },
            ]
        );
        let plain = r#"<multistatus xmlns="DAV:"><response><href>/a/b.json</href><propstat><prop><getcontentlength>5</getcontentlength></prop></propstat></response></multistatus>"#;
        assert_eq!(parse_multistatus(plain, "https://x/a/")[0].name, "b.json");
    }

    #[test]
    fn addresses_encode_each_segment() {
        let dav = WebDav::new("https://dav.example.com/dav", "user", "pass").unwrap();
        assert_eq!(
            dav.url("GripRead/Books/云海 问道.txt", false),
            "https://dav.example.com/dav/GripRead/Books/%E4%BA%91%E6%B5%B7%20%E9%97%AE%E9%81%93.txt"
        );
        assert_eq!(
            dav.url("GripRead/Backups", true),
            "https://dav.example.com/dav/GripRead/Backups/"
        );
        assert!(WebDav::new("ftp://x", "", "").is_err());
        assert_eq!(dav.authorization, "Basic dXNlcjpwYXNz");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"a"), "YQ==");
    }
}

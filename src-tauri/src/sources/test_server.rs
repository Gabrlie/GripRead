//! An in-process HTTP server for source fixtures: controlled pages instead
//! of live sites.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn param(&self, name: &str) -> Option<String> {
        let source = if self.method == "POST" && !self.body.starts_with(b"{") {
            String::from_utf8_lossy(&self.body).to_string()
        } else {
            self.query.clone()
        };
        source.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == name).then(|| value.to_string())
        })
    }
}

pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn html(body: &str) -> Self {
        Self::bytes("text/html; charset=utf-8", body.as_bytes().to_vec())
    }

    pub fn json(body: &str) -> Self {
        Self::bytes("application/json", body.as_bytes().to_vec())
    }

    pub fn bytes(content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            content_type: content_type.to_string(),
            headers: Vec::new(),
            body,
        }
    }

    pub fn not_found() -> Self {
        Self {
            status: 404,
            content_type: "text/plain".to_string(),
            headers: Vec::new(),
            body: b"not found".to_vec(),
        }
    }
}

/// Serves `handler` on a local port and returns `http://127.0.0.1:port`.
pub fn start(handler: impl Fn(&Request) -> Response + Send + Sync + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handler = Arc::new(handler);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let handler = handler.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let target = parts.next().unwrap_or("/").to_string();
                let (path, query) = target.split_once('?').unwrap_or((&target, ""));
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
                }
                let request = Request {
                    method,
                    path: path.to_string(),
                    query: query.to_string(),
                    headers,
                    body,
                };
                let response = handler(&request);
                let mut head = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                    response.status,
                    response.content_type,
                    response.body.len()
                );
                for (key, value) in &response.headers {
                    head.push_str(&format!("{key}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&response.body);
            });
        }
    });
    base
}

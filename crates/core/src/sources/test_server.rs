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

/// A site of plain HTML pages read with Legado's default rules.
pub fn html_site() -> String {
    start(|request: &Request| {
        let page = match request.path.as_str() {
            "/search" => {
                assert_eq!(request.param("q").as_deref(), Some("%E5%89%91%E6%9D%A5"));
                r#"<div class="result">
                  <div class="item"><a class="name" href="/book/7/">剑来</a><span class="author">作者：烽火</span>
                    <span class="kind">玄幻</span><span class="kind">连载</span><img src="/c/7.jpg">
                    <p class="intro">简介第一行<br>第二行</p><span class="last">第三章 春</span></div>
                  <div class="item"><a class="name" href="/book/8/">剑来外传</a><span class="author">某人</span></div>
                  <div class="item"><span class="author">没有书名的项</span></div>
                </div>"#
            }
            "/book/7/" => {
                r#"<html><head><meta property="og:novel:author" content="烽火戏诸侯"></head><body>
                  <h1>剑来</h1><img id="cover" src="/c/7-big.jpg"><div id="intro">大千世界，<br>无奇不有。</div>
                  <a id="toc" href="list_1.html">目录</a></body></html>"#
            }
            "/book/7/list_1.html" => {
                r#"<dl id="list"><dt>最新章节</dt><dd><a href="3.html">第三章 春</a></dd>
                  <dt>正文</dt><dd><a href="1.html">第一章 惊蛰</a></dd><dd><a href="2.html">第二章 开门</a></dd></dl>
                  <a id="next" href="list_2.html">下一页</a>"#
            }
            "/book/7/list_2.html" => {
                r#"<dl id="list"><dd><a href="3.html">第三章 春</a></dd></dl>"#
            }
            "/book/7/1.html" => {
                r#"<div id="content">第一章 惊蛰<br>　　第一段&amp;内容<br><br>第二段<script>ad()</script></div>
                  <a href="1_2.html">下一页</a>"#
            }
            "/book/7/1_2.html" => r#"<div id="content">第三段</div><a href="2.html">下一页</a>"#,
            "/book/7/2.html" => panic!("paging must stop at the next chapter"),
            _ => return Response::not_found(),
        };
        Response::html(page)
    })
}

pub fn html_source(base: &str) -> serde_json::Value {
    serde_json::json!({
        "bookSourceUrl": base,
        "bookSourceName": "甲站",
        "searchUrl": "/search?q={{key}}&p={{page}}",
        "exploreUrl": "玄幻::/sort/1_{{page}}.html&&都市::/sort/2_{{page}}.html\n完本",
        "ruleSearch": {
            "bookList": "class.item",
            "name": "class.name@text",
            "author": "class.author@text",
            "kind": "class.kind@text",
            "coverUrl": "tag.img@src",
            "intro": "class.intro@html",
            "lastChapter": "class.last@text",
            "bookUrl": "class.name@href"
        },
        "ruleBookInfo": {
            "name": "tag.h1@text",
            "author": "@css:meta[property=og:novel:author]@content",
            "intro": "id.intro@html",
            "coverUrl": "id.cover@src",
            "tocUrl": "id.toc@href"
        },
        "ruleToc": {
            "chapterList": "id.list@dd",
            "chapterName": "tag.a@text",
            "chapterUrl": "tag.a@href",
            "nextTocUrl": "id.next@href"
        },
        "ruleContent": {
            "content": "id.content@html",
            "nextContentUrl": "text.下一页@href"
        }
    })
}

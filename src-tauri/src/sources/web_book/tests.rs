//! Full search → details → contents → chapter chains against controlled
//! fixture sites served in process.

use std::sync::Mutex;

use base64::Engine as _;

use super::*;
use crate::sources::context::MemoryStore;
use crate::sources::test_server::{self, Request, Response};

fn session(source: serde_json::Value) -> SourceSession {
    SourceSession::new(
        BookSource::from_value(source).unwrap(),
        Arc::new(MemoryStore::default()),
        Control::unlimited(),
    )
    .unwrap()
}

fn book_ref(book: BookData) -> BookRef {
    Rc::new(RefCell::new(book))
}

/// A site of plain HTML pages read with Legado's default rules.
fn html_site() -> String {
    test_server::start(|request: &Request| {
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

fn html_source(base: &str) -> serde_json::Value {
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

#[test]
fn html_site_runs_from_search_to_content() {
    let base = html_site();
    let session = session(html_source(&base));
    let results = session.search("剑来", 1).unwrap();
    assert_eq!(results.len(), 2, "{:?}", session.logs());
    let first = &results[0];
    assert_eq!(first.name, "剑来");
    assert_eq!(first.author, "烽火");
    assert_eq!(first.kind, "玄幻,连载");
    assert_eq!(first.cover_url, format!("{base}/c/7.jpg"));
    assert_eq!(
        first.intro,
        "\u{3000}\u{3000}简介第一行\n\u{3000}\u{3000}第二行"
    );
    assert_eq!(first.latest_chapter_title, "第三章 春");
    assert_eq!(first.book_url, format!("{base}/book/7/"));
    assert_eq!(first.origin, base);

    let book = book_ref(first.clone());
    session.book_info(&book, false).unwrap();
    {
        let data = book.borrow();
        // Search gave an author already; details may only fill blanks.
        assert_eq!(data.author, "烽火");
        assert_eq!(data.cover_url, format!("{base}/c/7-big.jpg"));
        assert_eq!(data.toc_url, format!("{base}/book/7/list_1.html"));
        assert!(data.intro.contains("无奇不有"));
    }

    let chapters = session.chapters(&book).unwrap();
    let titles: Vec<&str> = chapters
        .iter()
        .map(|chapter| chapter.title.as_str())
        .collect();
    assert_eq!(titles, vec!["第一章 惊蛰", "第二章 开门", "第三章 春"]);
    assert_eq!(chapters[2].index, 2);
    assert_eq!(
        chapter_absolute_url(&chapters[0]),
        format!("{base}/book/7/1.html")
    );

    let urls: Vec<String> = chapters.iter().map(chapter_absolute_url).collect();
    let next = urls.get(1).cloned();
    let content = session
        .content(&book, &chapters[0], next.as_deref(), &urls)
        .unwrap();
    assert_eq!(content.text, "第一段&内容\n第二段\n第三段");

    let kinds = session.explore_kinds().unwrap();
    assert_eq!(kinds.len(), 3);
    assert_eq!(kinds[1].title, "都市");
    assert_eq!(kinds[1].url.as_deref(), Some("/sort/2_{{page}}.html"));
    assert_eq!(kinds[2].url, None);
}

const AES_KEY: &[u8] = b"0123456789abcdef";

fn encrypted(text: &str) -> String {
    let cipher =
        crate::sources::js::crypto::SymmetricCrypto::new("AES/ECB/PKCS5Padding", AES_KEY, None)
            .unwrap();
    base64::engine::general_purpose::STANDARD.encode(cipher.encrypt(text.as_bytes()).unwrap())
}

/// A JSON API with a token header, a POST search, variables, and encrypted
/// chapter text.
fn json_site() -> String {
    let content = encrypted("第一段\n第二段");
    test_server::start(move |request: &Request| {
        assert_eq!(
            request.headers.get("x-token").map(String::as_str),
            Some("abc")
        );
        let body = match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/api/search") => {
                let sent: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                assert_eq!(sent["kw"], "剑来");
                assert_eq!(sent["page"], 1);
                assert!(request.headers["content-type"].starts_with("application/json"));
                r#"{"code":0,"data":{"list":[{"id":7,"title":"剑来","writer":"烽火","cover":"/img/7.jpg","tags":["玄幻","完结"]}]}}"#.to_string()
            }
            ("GET", "/api/book/7") => {
                r#"{"data":{"id":7,"title":"剑来","writer":"烽火","desc":"一段简介","chapters":"/api/toc/7"}}"#.to_string()
            }
            ("GET", "/api/toc/7") => {
                r#"{"data":[{"cid":1,"name":"第一章","vip":0},{"cid":2,"name":"第二章","vip":1}]}"#.to_string()
            }
            ("GET", "/api/content/7/1") => format!(r#"{{"data":{{"text":"{content}"}}}}"#),
            ("GET", "/rank/2") => r#"{"data":{"list":[{"id":9,"title":"榜首","writer":"甲"}]}}"#.to_string(),
            _ => return Response::not_found(),
        };
        Response::json(&body)
    })
}

#[test]
fn json_site_with_scripts_variables_and_decryption() {
    let base = json_site();
    let session = session(serde_json::json!({
        "bookSourceUrl": base,
        "bookSourceName": "乙站",
        "header": "{\"X-Token\":\"abc\"}",
        "jsLib": "function decrypt(t) { return java.createSymmetricCrypto('AES/ECB/PKCS5Padding', '0123456789abcdef').decryptStr(t) }",
        "searchUrl": "/api/search,{\"method\":\"POST\",\"body\":{\"kw\":\"{{key}}\",\"page\":{{page}}}}",
        "exploreUrl": "@js:JSON.stringify([{title:'榜单', url:'/rank/{{page}}'}])",
        "ruleSearch": {
            "bookList": "$.data.list[*]",
            "name": "$.title",
            "author": "$.writer",
            "kind": "$.tags",
            "coverUrl": "$.cover",
            "bookUrl": "/api/book/{{$.id}}"
        },
        "ruleBookInfo": {
            "init": "$.data",
            "name": "@put:{bid:\"$.id\"}$.title",
            "intro": "$.desc",
            "tocUrl": "$.chapters"
        },
        "ruleToc": {
            "chapterList": "$.data[*]",
            "chapterName": "$.name",
            "chapterUrl": "/api/content/@get:{bid}/{{$.cid}}",
            "isVip": "$.vip"
        },
        "ruleContent": {"content": "$.data.text@js:decrypt(result)"}
    }));
    let results = session.search("剑来", 1).unwrap();
    assert_eq!(results.len(), 1, "{:?}", session.logs());
    assert_eq!(results[0].kind, "玄幻,完结");
    assert_eq!(results[0].book_url, format!("{base}/api/book/7"));
    let book = book_ref(results[0].clone());
    session.book_info(&book, false).unwrap();
    assert_eq!(book.borrow().variables["bid"], "7");
    assert_eq!(book.borrow().toc_url, format!("{base}/api/toc/7"));
    let chapters = session.chapters(&book).unwrap();
    assert_eq!(chapters.len(), 2);
    assert_eq!(chapters[0].url, "/api/content/7/1");
    assert!(!chapters[0].is_vip);
    assert!(chapters[1].is_vip);
    let content = session.content(&book, &chapters[0], None, &[]).unwrap();
    assert_eq!(content.text, "第一段\n第二段");

    let kinds = session.explore_kinds().unwrap();
    assert_eq!(kinds[0].title, "榜单");
    let ranked = session
        .explore(kinds[0].url.as_deref().unwrap(), 2)
        .unwrap();
    assert_eq!(ranked[0].name, "榜首");
}

fn gbk(text: &str) -> Vec<u8> {
    encoding_rs::GBK.encode(text).0.into_owned()
}

/// A GBK site searched by form POST and read with XPath; its details page
/// is also its table of contents.
fn gbk_site() -> String {
    test_server::start(|request: &Request| {
        let page = match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/s.php") => {
                assert_eq!(
                    String::from_utf8_lossy(&request.body),
                    "searchkey=%BD%A3%C0%B4"
                );
                r#"<table><tr><th>书名</th></tr><tr><td class="odd"><a href="/b/7.htm">剑来</a></td><td class="odd">烽火</td></tr></table>"#
            }
            ("GET", "/b/7.htm") => {
                r#"<div id="info"><h1>剑来</h1><p>作&nbsp;&nbsp;者：烽火</p></div>
                   <div id="list"><a href="/b/7/1.htm">第一章</a><a href="/b/7/2.htm">第二章</a></div>"#
            }
            ("GET", "/b/7/1.htm") => r#"<div id="content">甲段<br/>乙段</div>"#,
            _ => return Response::not_found(),
        };
        Response::bytes("text/html; charset=gbk", gbk(page))
    })
}

#[test]
fn gbk_site_with_form_post_and_xpath() {
    let base = gbk_site();
    let session = session(serde_json::json!({
        "bookSourceUrl": base,
        "bookSourceName": "丙站",
        "searchUrl": "/s.php,{\"method\":\"POST\",\"body\":\"searchkey={{key}}\",\"charset\":\"gbk\"}",
        "ruleSearch": {
            "bookList": "//table//tr[td]",
            "name": "//td[1]/a/text()",
            "author": "//td[2]/text()",
            "bookUrl": "//td[1]/a/@href"
        },
        "ruleBookInfo": {"name": "//div[@id='info']/h1/text()"},
        "ruleToc": {"chapterList": "//div[@id='list']/a", "chapterName": "//a/text()", "chapterUrl": "//a/@href"},
        "ruleContent": {"content": "id.content@html"}
    }));
    let results = session.search("剑来", 1).unwrap();
    assert_eq!(results.len(), 1, "{:?}", session.logs());
    assert_eq!(results[0].name, "剑来");
    assert_eq!(results[0].author, "烽火");
    let book = book_ref(results[0].clone());
    session.book_info(&book, false).unwrap();
    assert_eq!(book.borrow().toc_url, format!("{base}/b/7.htm"));
    assert!(book.borrow().toc_html.is_some());
    let chapters = session.chapters(&book).unwrap();
    assert_eq!(
        chapters
            .iter()
            .map(|c| c.title.as_str())
            .collect::<Vec<_>>(),
        vec!["第一章", "第二章"]
    );
    let content = session.content(&book, &chapters[0], None, &[]).unwrap();
    assert_eq!(content.text, "甲段\n乙段");
}

#[test]
fn regex_lists_scripted_titles_and_reversed_contents() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let base = test_server::start(move |request: &Request| {
        seen.lock().unwrap().push(request.path.clone());
        match request.path.as_str() {
            "/d/list" => Response::html(
                r#"<li><a href="/d/3">三</a></li><li><a href="/d/2">二</a></li><li><a href="/d/1">一</a></li>"#,
            ),
            "/d/1" => Response::html("<p>正文一</p>"),
            _ => Response::not_found(),
        }
    });
    let session = session(serde_json::json!({
        "bookSourceUrl": base,
        "bookSourceName": "丁站",
        "ruleToc": {
            "chapterList": "-:<a href=\"([^\"]+)\">([^<]+)</a>",
            "chapterName": "$2",
            "chapterUrl": "$1",
            "formatJs": "gInt++; '第' + index + '章 ' + title + '/' + gInt"
        },
        "ruleContent": {"content": "@js:result.replace('一', '壹')"}
    }));
    let book = book_ref(BookData {
        name: "倒序书".into(),
        book_url: format!("{base}/d/"),
        toc_url: format!("{base}/d/list"),
        ..Default::default()
    });
    let chapters = session.chapters(&book).unwrap();
    let titles: Vec<&str> = chapters
        .iter()
        .map(|chapter| chapter.title.as_str())
        .collect();
    assert_eq!(titles, vec!["第1章 一/1", "第2章 二/2", "第3章 三/3"]);
    let content = session.content(&book, &chapters[0], None, &[]).unwrap();
    assert_eq!(content.text, "正文壹");
}

#[test]
fn missing_rules_and_unsupported_pages_report_their_kind() {
    let session = session(
        serde_json::json!({"bookSourceUrl": "https://example.invalid", "bookSourceName": "空"}),
    );
    let error = session.search("x", 1).unwrap_err();
    assert_eq!(error.kind, crate::sources::error::SourceErrorKind::Rule);
    let web_view = session_with_web_view();
    let error = web_view.search("x", 1).unwrap_err();
    assert_eq!(
        error.kind,
        crate::sources::error::SourceErrorKind::Unsupported
    );
}

fn session_with_web_view() -> SourceSession {
    session(serde_json::json!({
        "bookSourceUrl": "https://example.invalid",
        "bookSourceName": "网页",
        "searchUrl": "/s?q={{key}},{\"webView\":true}",
        "ruleSearch": {"bookList": "li"}
    }))
}

#[test]
fn list_helpers_follow_legado() {
    assert_eq!(word_count_format("123456"), "12.3万字");
    assert_eq!(word_count_format("800"), "800字");
    assert_eq!(word_count_format("约30万字"), "约30万字");
    assert_eq!(format_book_name("剑来 作者：烽火"), "剑来");
    assert_eq!(format_book_author("作者：烽火"), "烽火");
    assert!(is_true("1") && is_true("true") && !is_true("0") && !is_true("false") && !is_true(""));
    assert_eq!(
        content_paragraphs("<p>　　甲&amp;乙</p><br/><p>&nbsp;</p>丙"),
        "甲&乙\n丙"
    );
}

#[test]
fn cookies_from_redirects_are_kept_and_sent_and_rates_space_requests() {
    let base = test_server::start(|request: &Request| match request.path.as_str() {
        "/login" => Response {
            status: 302,
            content_type: "text/html".into(),
            headers: vec![
                ("Set-Cookie".into(), "sid=42; Path=/; HttpOnly".into()),
                ("Location".into(), "/home".into()),
            ],
            body: Vec::new(),
        },
        "/home" | "/check" => {
            let cookie = request.headers.get("cookie").cloned().unwrap_or_default();
            Response::html(&format!("<p id=\"c\">{cookie}</p>"))
        }
        _ => Response::not_found(),
    });
    let session = session(serde_json::json!({
        "bookSourceUrl": base,
        "bookSourceName": "戊站",
        "enabledCookieJar": true,
        "concurrentRate": "150"
    }));
    let started = std::time::Instant::now();
    let value = session
        .run_script(
            "java.ajax(source.getKey() + '/login'); java.ajax(source.getKey() + '/check')",
            None,
        )
        .unwrap();
    assert!(value.to_text().contains("sid=42"), "{}", value.to_text());
    assert_eq!(
        session
            .run_script("cookie.getKey(source.getKey(), 'sid')", None)
            .unwrap()
            .to_text(),
        "42"
    );
    // Two requests (the redirect is part of the first) at one per 150 ms.
    assert!(started.elapsed() >= std::time::Duration::from_millis(150));
}

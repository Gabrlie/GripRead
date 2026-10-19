//! Full search → details → contents → chapter chains against controlled
//! fixture sites served in process.

use std::sync::Mutex;

use base64::Engine as _;

use super::*;
use crate::sources::context::MemoryStore;
use crate::sources::test_server::{self, html_site, html_source, Request, Response};

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

/// Comic sources written for Legado: a jsLib `Map()` over the login info
/// (null with none saved), a list script that builds objects from an HTML
/// page with `java.getElements(...).text()`, `var Date` shadowing the
/// built-in, and `{{name}}` in the script's own regex. The field rules then
/// read the objects' keys, as Legado does for a script's objects.
#[test]
fn scripted_object_lists_on_html_pages_read_like_legado() {
    let base = test_server::start(|request: &Request| match request.path.as_str() {
        "/rank" => Response::html(
            r#"<p class="date">2026</p><div class="card"><a href="/b/1"><b>海贼{{name}}</b></a></div><div class="card"><a href="/b/2"><b>火影</b></a></div>"#,
        ),
        _ => Response::not_found(),
    });
    let session = session(serde_json::json!({
        "bookSourceUrl": base,
        "bookSourceName": "漫画站",
        "bookSourceType": 2,
        "jsLib": "function Map(e) { var info = source.getLoginInfoMap(); \
            return String(info !== null && info.get(e) ? info.get(e) : ''); }",
        "exploreUrl": "<js>JSON.stringify([{title: '排行' + Map('代理'), url: '/rank'}])</js>",
        "ruleExplore": {
            "bookList": "<js>var Date = String(java.getElements('.date').text()) + new Date().getFullYear(); \
                var list = java.getElements('.card'); var data = []; \
                for (i in list) data.push({ name: String(list[i].select('b').text()).replace(/{{name}}/g, ''), \
                    url: list[i].select('a').attr('href'), latest: Date }); \
                JSON.parse(JSON.stringify(data));</js>",
            "name": "name",
            "bookUrl": "url",
            "lastChapter": "latest"
        }
    }));
    let kinds = session.explore_kinds().unwrap();
    assert_eq!(kinds[0].title, "排行");
    let books = session.explore("/rank", 1).unwrap();
    let names: Vec<&str> = books.iter().map(|book| book.name.as_str()).collect();
    assert_eq!(names, ["海贼", "火影"], "{:?}", session.logs());
    assert_eq!(books[0].book_url, format!("{base}/b/1"));
    assert!(books[0].latest_chapter_title.starts_with("2026"));
    assert!(books[0].comic);
}

#[test]
fn a_details_script_reusing_base_url_keeps_the_books_post_options() {
    let base = test_server::start(|request: &Request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/detail") => {
                let sent: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                Response::json(&format!(
                    r#"{{"data":{{"id":{},"title":"海贼","chapters":[{{"name":"第1话","cid":11}}]}}}}"#,
                    sent["comic_id"]
                ))
            }
            ("GET", "/detail") => Response::json(r#"{"code":"bad_route","msg":"only POST"}"#),
            _ => Response::not_found(),
        }
    });
    let session = session(serde_json::json!({
        "bookSourceUrl": base,
        "bookSourceName": "漫画站",
        "bookSourceType": 2,
        "ruleBookInfo": {
            "init": "<js>var d = JSON.parse(result).data; d.url = baseUrl; d</js>",
            "name": "title",
            "tocUrl": "url"
        },
        "ruleToc": {
            "chapterList": "<js>var id = JSON.parse(result).data.id; \
                JSON.parse(result).data.chapters.map(c => ({name: c.name, url: '/p/' + id + '/' + c.cid}))</js>",
            "chapterName": "name",
            "chapterUrl": "url"
        }
    }));
    let address = format!(r#"{base}/detail,{{"method":"POST","body":{{"comic_id":7}}}}"#);
    let book = book_ref(BookData {
        book_url: address.clone(),
        ..Default::default()
    });
    session.book_info(&book, false).unwrap();
    assert_eq!(book.borrow().toc_url, address, "{:?}", session.logs());
    let chapters = session.chapters(&book).unwrap();
    assert_eq!(chapters[0].url, "/p/7/11", "{:?}", session.logs());
}

#[test]
fn explore_scripts_see_the_source_address_and_fail_on_error_text() {
    let base = test_server::start(|_: &Request| Response::not_found());
    let session = session(serde_json::json!({
        "bookSourceUrl": base,
        "bookSourceName": "漫画站",
        "exploreUrl": "<js>var kind = JSON.parse(java.ajax(baseUrl + '/kinds'))[0].items; \
            JSON.stringify([{title: String(kind.length), url: '/rank'}])</js>"
    }));
    let kinds = session.explore_kinds().unwrap();
    let title = &kinds[0].title;
    // Rhino's JSON.parse throws on the failed request's text, and the
    // message says what the text was rather than reading `.length`.
    assert!(title.starts_with("ERROR:"), "{title}");
    assert!(title.contains("JSON.parse"), "{title}");
    assert!(!title.contains("length"), "{title}");
    let session = session_of(
        &base,
        "<js>JSON.stringify([{title: baseUrl, url: '/rank'}])</js>",
    );
    assert_eq!(session.explore_kinds().unwrap()[0].title, base);
}

fn session_of(base: &str, explore_url: &str) -> SourceSession {
    session(serde_json::json!({
        "bookSourceUrl": base,
        "bookSourceName": "漫画站",
        "exploreUrl": explore_url
    }))
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
    // A picture is a line of its own, its lazy-loaded address preferred.
    assert_eq!(
        content_paragraphs(
            "<p>甲<img src=\"x.gif\" data-original=\"https://a.cn/1.jpg\">乙</p><img alt=1>"
        ),
        "甲\n<img src=\"https://a.cn/1.jpg\">\n乙"
    );
    assert_eq!(
        absolute_images("<img src='/p/2.png'>", "https://a.cn/book/3.html"),
        "\n<img src=\"https://a.cn/p/2.png\">\n"
    );
    assert_eq!(
        image_of_line("<img src=\"https://a.cn/p/2.png\">"),
        Some("https://a.cn/p/2.png")
    );
    assert_eq!(image_of_line("正文"), None);
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

#[test]
fn web_view_pages_render_through_the_host_with_cookies() {
    use crate::sources::webview::{testing, WebResult};
    let store = Arc::new(MemoryStore::default());
    store.cookie_put("example.invalid", "sid=1");
    let source = BookSource::from_value(serde_json::json!({
        "bookSourceUrl": "https://example.invalid",
        "bookSourceName": "网页",
        "searchUrl": "/s?q={{key}},{\"webView\":true}",
        "ruleSearch": {"bookList": "li", "name": "a@text", "bookUrl": "a@href"},
        "ruleToc": {"chapterList": "li", "chapterName": "a@text", "chapterUrl": "a@href"},
        "ruleContent": {"content": "id.c@text", "webJs": "document.body.innerHTML"}
    }))
    .unwrap();
    let session = SourceSession::new(source, store.clone(), Control::unlimited()).unwrap();
    let host = testing::fake(|request| {
        Ok(WebResult {
            url: request.url.clone(),
            body: if request.url.contains("/s?") {
                r#"<ul><li><a href="/b/1">剑来</a></li></ul>"#.into()
            } else {
                r#"<div id="c">渲染出的正文</div>"#.into()
            },
            cookies: Some("cf=ok".into()),
        })
    });
    testing::with_host(host.clone(), || {
        let results = session.search("剑来", 1).unwrap();
        assert_eq!(results[0].name, "剑来");
        assert_eq!(results[0].book_url, "https://example.invalid/b/1");
        // The stored session went to the page, and the page's cookie came back.
        let seen = host.seen.lock().unwrap()[0].clone();
        assert!(seen
            .headers
            .iter()
            .any(|(key, value)| key == "Cookie" && value.contains("sid=1")));
        assert!(store
            .cookie_get("example.invalid")
            .unwrap()
            .contains("cf=ok"));

        let book = book_ref(results[0].clone());
        let chapter = ChapterData {
            title: "第一章".into(),
            url: "https://example.invalid/c/1,{\"webView\":true}".into(),
            ..Default::default()
        };
        let content = session.content(&book, &chapter, None, &[]).unwrap();
        assert_eq!(content.text, "渲染出的正文");
        let seen = host.seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!(seen.js.as_deref(), Some("document.body.innerHTML"));

        let rendered = session
            .run_script(
                "java.webView('<p>x</p>', 'https://example.invalid/p', 'document.title')",
                None,
            )
            .unwrap();
        assert!(rendered.to_text().contains("渲染出的正文"));
        let seen = host.seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!(seen.html.as_deref(), Some("<p>x</p>"));
        let page = session
            .run_script(
                "java.startBrowserAwait('https://example.invalid/v', '验证').body()",
                None,
            )
            .unwrap();
        assert_eq!(page.to_text(), "<html>done</html>");
        assert!(store
            .cookie_get("example.invalid")
            .unwrap()
            .contains("token=abc"));
    });
}

#[test]
fn a_web_login_closes_once_the_source_login_succeeds() {
    use crate::sources::webview::{testing, WebResult};
    let store = Arc::new(MemoryStore::default());
    let source = BookSource::from_value(serde_json::json!({
        "bookSourceUrl": "https://example.invalid",
        "bookSourceName": "登录",
        "enabledCookieJar": true
    }))
    .unwrap();
    let session = SourceSession::new(source, store.clone(), Control::unlimited()).unwrap();
    let page = |url: &str, cookies: &str| WebResult {
        url: url.into(),
        body: String::new(),
        cookies: Some(cookies.into()),
    };
    let host = testing::fake(|_| Err("unused".into()));
    *host.pages.lock().unwrap() = vec![
        page("https://example.invalid/login", "visit=1"),
        page("https://example.invalid/home", "visit=1; sid=42_x"),
        page("https://example.invalid/after", "visit=1; sid=42_x"),
    ];
    let login = "function login() { var sid = String(cookie.getKey('https://example.invalid', 'sid') || ''); if (!sid) throw new Error('not yet'); return '已登录 ' + sid }";
    testing::with_host(host.clone(), || {
        let (result, answer) = session
            .login_in_page("https://example.invalid/login", "登录", Some(login))
            .unwrap();
        // The first page had no session; the second closed the page.
        assert_eq!(*host.checked.lock().unwrap(), 2);
        assert_eq!(result.url, "https://example.invalid/home");
        assert_eq!(answer.as_deref(), Some("已登录 42_x"));
        // Without a login(), the reader closes the page and nothing is confirmed.
        *host.pages.lock().unwrap() = vec![page("https://example.invalid/a", "x=1")];
        let (_, answer) = session
            .login_in_page("https://example.invalid/login", "登录", None)
            .unwrap();
        assert_eq!(answer, None);
    });
}

#[test]
fn a_source_set_to_go_through_the_server_sends_its_requests_there() {
    use crate::sources::http::{testing, via_server_key, HopAnswer};
    // The site itself is unreachable: only the relay answers.
    let base = "http://127.0.0.1:9";
    let mut raw = html_source(base);
    raw["enabledCookieJar"] = serde_json::json!(true);
    let source = BookSource::from_value(raw.clone()).unwrap();
    let store = Arc::new(MemoryStore::default());
    store.cache_put(&via_server_key(base), "1", 0);
    let session = SourceSession::new(source, store.clone(), Control::unlimited()).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let relayed = seen.clone();
    let found = testing::with_relay(
        move |hop| {
            relayed.lock().unwrap().push(hop.clone());
            Ok(HopAnswer {
                code: 200,
                message: "OK".into(),
                headers: vec![
                    ("Content-Type".into(), "text/html; charset=utf-8".into()),
                    ("Set-Cookie".into(), "sid=relay; Path=/".into()),
                ],
                bytes: r#"<div class="item"><a class="name" href="/book/7/">剑来</a></div>"#
                    .as_bytes()
                    .to_vec(),
            })
        },
        || session.search("剑来", 1).unwrap(),
    );
    assert_eq!(found[0].name, "剑来");
    let hops = seen.lock().unwrap().clone();
    assert_eq!(hops.len(), 1);
    assert!(hops[0].url.starts_with("http://127.0.0.1:9/search?q="));
    assert!(hops[0].headers.iter().any(|(key, _)| key == "User-Agent"));
    // The cookie the relayed answer set is kept on the device.
    assert!(store.cookie_get("127.0.0.1").unwrap().contains("sid=relay"));

    // A relay that fails sends the request directly instead.
    let site = html_site();
    let store = Arc::new(MemoryStore::default());
    store.cache_put(&via_server_key(&site), "1", 0);
    let session = SourceSession::new(
        BookSource::from_value(html_source(&site)).unwrap(),
        store,
        Control::unlimited(),
    )
    .unwrap();
    let (found, sent) = crate::notify::testing::capture(|| {
        testing::with_relay(
            |_| Err("服务器不可达".into()),
            || {
                session.search("剑来", 1).unwrap();
                session.search("剑来", 1).unwrap()
            },
        )
    });
    assert_eq!(found[0].name, "剑来");
    // The reader is told once that the source went direct.
    let notices: Vec<_> = sent
        .iter()
        .filter(|(event, _)| event == "source-notice")
        .collect();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].1["kind"], "relayFallback");
    assert_eq!(notices[0].1["source"], "甲站");
}

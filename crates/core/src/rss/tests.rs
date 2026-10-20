use super::*;
use crate::models::{ArticleFilter, ArticleQuery, RssSettings};
use crate::sources::test_server::{start, Request, Response};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

struct Dir(std::path::PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn library() -> (Dir, Mutex<Storage>) {
    let dir = Dir(std::env::temp_dir().join(format!("gripread-rss-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let storage = Storage::open(&dir.0).unwrap();
    (dir, Mutex::new(storage))
}

const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>甲博客</title><link>https://example.com/</link>
  <item><title>第一篇</title><link>/posts/1</link><guid>post-1</guid>
    <pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate>
    <description><![CDATA[<p onclick="x()">正文<script>alert(1)</script><img src="/a.png"><a href="javascript:alert(1)">坏链接</a></p>]]></description></item>
  <item><title>第二篇</title><link>https://example.com/posts/2</link><guid>post-2</guid>
    <pubDate>Tue, 13 Oct 2026 08:00:00 GMT</pubDate><description>纯文本摘要</description></item>
  <item><title>第二篇（重复）</title><link>https://example.com/posts/2</link><guid>post-2</guid></item>
  <item><description>没有标题也没有链接</description></item>
</channel></rss>"#;

const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>乙站</title><link href="https://b.example/" rel="alternate"/>
  <entry><id>tag:b,1</id><title>Atom 一</title><updated>2026-10-11T00:00:00Z</updated>
    <link href="https://b.example/1"/><author><name>作者乙</name></author>
    <content type="html">&lt;p&gt;内容&lt;/p&gt;</content></entry>
</feed>"#;

const RDF: &str = r#"<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://c.example/"><title>丙站</title><link>https://c.example/</link></channel>
  <item rdf:about="https://c.example/1"><title>RDF 一</title><link>https://c.example/1</link><description>描述</description></item>
</rdf:RDF>"#;

#[test]
fn rss_atom_and_rdf_parse_with_safe_content() {
    let feed = parse_feed("https://example.com/feed", RSS.as_bytes()).unwrap();
    assert_eq!(feed.title, "甲博客");
    // The repeated GUID counts once; an entry without title or link stays
    // (it has text), titled by its text.
    let titles: Vec<&str> = feed.articles.iter().map(|a| a.title.as_str()).collect();
    assert_eq!(titles, ["第一篇", "第二篇", "没有标题也没有链接"]);
    assert_eq!(
        feed.articles
            .iter()
            .filter(|a| a.title.starts_with("第二篇"))
            .count(),
        1
    );
    let first = &feed.articles[0];
    assert_eq!(first.link.as_deref(), Some("https://example.com/posts/1"));
    assert!(!first.content.contains("script") && !first.content.contains("onclick"));
    assert!(!first.content.contains("javascript:"));
    assert!(first
        .content
        .contains(r#"<img src="https://example.com/a.png">"#));
    assert_eq!(first.image.as_deref(), Some("https://example.com/a.png"));
    assert_eq!(first.excerpt, "正文 坏链接");
    assert!(first.published_at > 0);
    assert_eq!(feed.articles[1].content, "纯文本摘要");

    let atom = parse_feed("https://b.example/atom", ATOM.as_bytes()).unwrap();
    assert_eq!(atom.title, "乙站");
    assert_eq!(atom.articles[0].author.as_deref(), Some("作者乙"));
    assert_eq!(atom.articles[0].content, "<p>内容</p>");

    let rdf = parse_feed("https://c.example/rdf", RDF.as_bytes()).unwrap();
    assert_eq!(rdf.articles[0].title, "RDF 一");
    assert!(parse_feed("https://x", b"<html>not a feed</html>").is_err());
}

#[test]
fn refresh_keeps_state_and_old_articles_through_failures_and_304() {
    let served = Arc::new(AtomicU32::new(0));
    let seen = served.clone();
    let base = start(move |request: &Request| match request.path.as_str() {
        "/feed" => {
            let round = seen.fetch_add(1, Ordering::SeqCst);
            match round {
                0 => {
                    let mut response =
                        Response::bytes("application/rss+xml", RSS.as_bytes().to_vec());
                    response.headers.push(("ETag".into(), "\"v1\"".into()));
                    response
                }
                1 => {
                    assert_eq!(
                        request.headers.get("if-none-match").map(String::as_str),
                        Some("\"v1\"")
                    );
                    Response {
                        status: 304,
                        ..Response::bytes("text/plain", Vec::new())
                    }
                }
                _ => Response {
                    status: 500,
                    ..Response::bytes("text/plain", b"down".to_vec())
                },
            }
        }
        _ => Response::not_found(),
    });
    let (_dir, storage) = library();
    let url = format!("{base}/feed");
    subscribe(&storage, &url, None, Some("技术")).unwrap();
    let feeds = lock(&storage).unwrap().list_feeds().unwrap();
    assert_eq!((feeds[0].title.as_str(), feeds[0].unread), ("甲博客", 3));
    assert_eq!(feeds[0].group.as_deref(), Some("技术"));

    let page = lock(&storage)
        .unwrap()
        .list_articles(&ArticleQuery::default())
        .unwrap();
    let newest = page.articles[0].id.clone();
    lock(&storage)
        .unwrap()
        .set_article_state(std::slice::from_ref(&newest), Some(true), Some(true), None)
        .unwrap();

    assert_eq!(refresh_feed(&storage, &url).unwrap(), 0);
    assert!(refresh_feed(&storage, &url).is_err());
    let guard = lock(&storage).unwrap();
    let feeds = guard.list_feeds().unwrap();
    assert_eq!((feeds[0].total, feeds[0].unread), (3, 2));
    assert_eq!(feeds[0].last_error.as_deref(), Some("HTTP 500"));
    let starred = guard
        .list_articles(&ArticleQuery {
            filter: ArticleFilter::Starred,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(starred.articles[0].id, newest);
    drop(guard);
    assert!(subscribe(&storage, &url, None, None).is_err());
}

#[test]
fn pages_name_their_feeds() {
    let base = start(|request: &Request| match request.path.as_str() {
        "/" => Response::html(
            r#"<html><head><link rel="alternate" type="application/rss+xml" title="主订阅" href="/feed">
            <link rel="alternate" type="text/html" href="/other"></head></html>"#,
        ),
        "/feed" => Response::bytes("application/rss+xml", RSS.as_bytes().to_vec()),
        "/bare/" => Response::html("<html>no links</html>"),
        _ => Response::not_found(),
    });
    let found = discover(&format!("{base}/")).unwrap();
    assert_eq!(
        found,
        [FeedCandidate {
            url: format!("{base}/feed"),
            title: "主订阅".into()
        }]
    );
    let direct = discover(&format!("{base}/feed")).unwrap();
    assert_eq!(direct[0].title, "甲博客");
    // Without a link, the usual paths are tried.
    let guessed = discover(&format!("{base}/bare/")).unwrap();
    assert_eq!(guessed[0].url, format!("{base}/feed"));
}

#[test]
fn opml_round_trips_groups_without_duplicates() {
    let opml = r#"<?xml version="1.0"?><opml version="1.0"><head/><body>
      <outline text="新闻"><outline text="国内"><outline text="甲" xmlUrl="https://a.example/feed"/></outline>
        <outline text="乙" xmlUrl="https://b.example/feed" htmlUrl="https://b.example/"/></outline>
      <outline text="丙" xmlUrl="https://c.example/feed"/>
      <outline text="甲又一次" xmlUrl="https://a.example/feed"/>
    </body></opml>"#;
    let feeds = parse_opml(opml).unwrap();
    assert_eq!(feeds[0].group.as_deref(), Some("新闻 / 国内"));
    assert_eq!(feeds[1].group.as_deref(), Some("新闻"));
    assert_eq!(feeds[2].group, None);
    let (_dir, storage) = library();
    let report = import_opml(&storage, opml).unwrap();
    assert_eq!((report.added, report.existing), (3, 1));
    let exported = export_opml(&lock(&storage).unwrap()).unwrap();
    let (_other, again) = library();
    assert_eq!(import_opml(&again, &exported).unwrap().added, 3);
    let groups: Vec<Option<String>> = lock(&again)
        .unwrap()
        .list_feeds()
        .unwrap()
        .into_iter()
        .map(|f| f.group)
        .collect();
    assert!(groups.contains(&Some("新闻 / 国内".into())) && groups.contains(&None));
    assert_eq!(import_opml(&again, &exported).unwrap().existing, 3);
}

#[test]
fn sanitizing_keeps_reading_markup_only() {
    let html = r#"<div class="x" style="color:red"><h2>标题</h2><p>一<b>二</b><font>三</font></p>
      <img data-src="lazy.jpg" src="placeholder.gif" onerror="x()"><iframe src="https://evil"></iframe>
      <a href="//cdn.example/p" target="_blank">链</a><a href="mailto:a@b.c">信</a>
      <table><tr><td colspan="2x">格</td></tr></table><style>p{}</style></div>"#;
    let clean = sanitize(html, "https://site.example/post/1");
    assert_eq!(
        clean,
        "<div><h2>标题</h2><p>一<b>二</b>三</p>\n      \
         <img src=\"https://site.example/post/lazy.jpg\">\n      \
         <a href=\"https://cdn.example/p\">链</a><a href=\"mailto:a@b.c\">信</a>\n      \
         <table><tbody><tr><td>格</td></tr></tbody></table></div>"
    );
}

#[test]
fn full_text_finds_the_article_or_says_so() {
    let body = "这是正文的一段，内容很长，有很多逗号，用来让评分认出它。".repeat(6);
    let page = format!(
        r#"<html><body><nav><a href="/">首页</a><a href="/a">关于</a></nav>
        <div class="post-content"><p>{body}</p><p>{body}</p><img src="/pic.jpg"></div>
        <div class="sidebar"><p>侧栏的文字也不少，但是一堆链接，<a href="/x">链接链接链接链接链接</a></p></div>
        </body></html>"#
    );
    let main = extract_main(&page, "https://site.example/post/1").unwrap();
    assert!(main.contains(&body[..30]) && main.contains("https://site.example/pic.jpg"));
    assert!(!main.contains("首页") && !main.contains("侧栏"));
    assert!(extract_main("<html><body><p>短</p></body></html>", "https://x").is_none());
}

#[test]
fn charset_comes_from_the_header_or_the_page() {
    let (gbk, _, _) = encoding_rs::GBK.encode("中文页面");
    assert_eq!(decode_html(&gbk, "text/html; charset=gbk"), "中文页面");
    let page = [b"<meta charset=\"gb2312\">".as_slice(), &gbk].concat();
    assert!(decode_html(&page, "text/html").ends_with("中文页面"));
}

fn fetched(count: usize, start: i64) -> FetchedFeed {
    FetchedFeed {
        title: "源".into(),
        articles: (0..count)
            .map(|index| FetchedArticle {
                id: format!("{index:04}"),
                title: format!("文章 {index}"),
                excerpt: if index % 2 == 0 {
                    "偶数".into()
                } else {
                    "奇数".into()
                },
                published_at: start + index as i64 * 1000,
                ..FetchedArticle::default()
            })
            .collect(),
        ..FetchedFeed::default()
    }
}

#[test]
fn articles_page_filter_and_survive_as_kept() {
    let (_dir, storage) = library();
    let mut guard = lock(&storage).unwrap();
    guard
        .add_feed("https://a.example/feed", "", Some("组"), None)
        .unwrap();
    guard
        .add_feed("https://b.example/feed", "乙", None, None)
        .unwrap();
    // Old articles beyond what is kept go, unless starred.
    let old = 1_000_000;
    guard
        .store_feed_fetch("https://a.example/feed", &fetched(500, old))
        .unwrap();
    guard
        .set_article_state(&["0000".into()], None, Some(true), None)
        .unwrap();
    // Twenty newer ones push out the twenty oldest, but not the starred one.
    assert_eq!(
        guard
            .store_feed_fetch("https://a.example/feed", &fetched(520, old))
            .unwrap(),
        20
    );
    assert_eq!(
        guard
            .store_feed_fetch("https://a.example/feed", &fetched(520, old))
            .unwrap(),
        0
    );
    let feeds = guard.list_feeds().unwrap();
    assert_eq!((feeds[0].title.as_str(), feeds[0].total), ("源", 501));
    // Pages follow each other without gaps.
    let mut seen = 0;
    let mut query = ArticleQuery {
        feed: Some("https://a.example/feed".into()),
        limit: Some(200),
        ..Default::default()
    };
    loop {
        let page = guard.list_articles(&query).unwrap();
        seen += page.articles.len();
        match page.next {
            Some(next) => query.after = Some(next),
            None => break,
        }
    }
    assert_eq!(seen, 501);
    let search = |text: &str| ArticleQuery {
        search: Some(text.into()),
        limit: Some(200),
        ..Default::default()
    };
    assert_eq!(
        guard.list_articles(&search("奇数")).unwrap().articles.len(),
        200
    );
    assert_eq!(
        guard.list_articles(&search("100%")).unwrap().articles.len(),
        0
    );
    assert_eq!(guard.mark_all_read(None, Some("组")).unwrap(), 501);
    let unread = ArticleQuery {
        filter: ArticleFilter::Unread,
        ..Default::default()
    };
    assert!(guard.list_articles(&unread).unwrap().articles.is_empty());
    // Unsubscribing keeps starred articles, among the starred only.
    guard
        .remove_feeds(&["https://a.example/feed".into()])
        .unwrap();
    assert!(guard
        .list_articles(&ArticleQuery::default())
        .unwrap()
        .articles
        .is_empty());
    let starred = ArticleQuery {
        filter: ArticleFilter::Starred,
        ..Default::default()
    };
    let kept = guard.list_articles(&starred).unwrap().articles;
    assert_eq!((kept.len(), kept[0].feed_title.as_str()), (1, "源"));
    guard
        .set_article_state(&["0000".into()], None, Some(false), None)
        .unwrap();
    assert!(guard.list_articles(&starred).unwrap().articles.is_empty());
}

#[test]
fn the_kept_days_setting_decides_how_far_back_articles_stay() {
    let (_dir, storage) = library();
    let mut guard = lock(&storage).unwrap();
    guard
        .add_feed("https://a.example/feed", "", None, None)
        .unwrap();
    // 510 articles from 60 days ago: within 90 days all stay.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let sixty_days_ago = now - 60 * 86_400_000;
    guard
        .store_feed_fetch("https://a.example/feed", &fetched(510, sixty_days_ago))
        .unwrap();
    assert_eq!(guard.list_feeds().unwrap()[0].total, 510);
    // Keeping 30 days leaves the newest 500 at the next refresh.
    let saved = guard
        .save_rss_settings(&RssSettings {
            keep_days: 30,
            ..RssSettings::default()
        })
        .unwrap();
    assert_eq!(saved.keep_days, 30);
    guard
        .store_feed_fetch("https://a.example/feed", &fetched(510, sixty_days_ago))
        .unwrap();
    assert_eq!(guard.list_feeds().unwrap()[0].total, 500);
    // A choice the reader cannot make falls back to the default.
    let saved = guard
        .save_rss_settings(&RssSettings {
            keep_days: 7,
            auto_full_text: true,
            ..RssSettings::default()
        })
        .unwrap();
    assert_eq!((saved.keep_days, saved.auto_full_text), (90, true));
    assert_eq!(guard.rss_settings(), saved);
}

#[test]
fn articles_above_or_below_one_are_marked_read_but_those_kept_unread() {
    let (_dir, storage) = library();
    let mut guard = lock(&storage).unwrap();
    guard
        .add_feed("https://a.example/feed", "", None, None)
        .unwrap();
    guard
        .store_feed_fetch("https://a.example/feed", &fetched(6, 1_000))
        .unwrap();
    // Newest first: 0005 … 0000. 0004 is kept unread.
    guard
        .set_article_state(&["0004".into()], None, None, Some(true))
        .unwrap();
    let query = ArticleQuery::default();
    let from = |id: &str| crate::models::ArticleCursor {
        published_at: 1_000 + id.parse::<i64>().unwrap() * 1000,
        id: id.into(),
    };
    // 以上 from 0003: 0005 and 0003 (0004 is kept unread).
    assert_eq!(
        guard.mark_read_range(&query, &from("0003"), true).unwrap(),
        2
    );
    // 以下 from 0001: 0001 and 0000.
    assert_eq!(
        guard.mark_read_range(&query, &from("0001"), false).unwrap(),
        2
    );
    let unread: Vec<String> = guard
        .list_articles(&ArticleQuery {
            filter: ArticleFilter::Unread,
            ..Default::default()
        })
        .unwrap()
        .articles
        .into_iter()
        .map(|article| article.id)
        .collect();
    assert_eq!(unread, ["0004", "0002"]);
    // 全部标为已读 leaves it too; the reader's own mark takes it off.
    assert_eq!(guard.mark_all_read(None, None).unwrap(), 1);
    assert!(guard.rss_article("0004").unwrap().summary.keep_unread);
    guard
        .set_article_state(&["0004".into()], Some(true), None, None)
        .unwrap();
    let article = guard.rss_article("0004").unwrap().summary;
    assert!(article.read && !article.keep_unread);
}

#[test]
fn feeds_refresh_on_their_own_interval_and_groups_keep_their_order() {
    let (_dir, storage) = library();
    let mut guard = lock(&storage).unwrap();
    for (url, group) in [
        ("https://a.example/feed", Some("甲")),
        ("https://b.example/feed", Some("乙")),
        ("https://c.example/feed", None),
    ] {
        guard.add_feed(url, "", group, None).unwrap();
    }
    // None fetched yet: all are due; with refreshing off, none is.
    assert_eq!(guard.refresh_targets(&[], true, 60).unwrap().len(), 3);
    assert!(guard.refresh_targets(&[], true, 0).unwrap().is_empty());
    for url in guard.feed_urls().unwrap() {
        guard.record_feed_unchanged(&url).unwrap();
    }
    assert!(guard.refresh_targets(&[], true, 60).unwrap().is_empty());
    // A feed of its own five minutes is due when that has passed.
    let feed = guard.feed("https://b.example/feed").unwrap();
    guard
        .update_feed(&crate::models::UpdateFeedRequest {
            url: feed.url.clone(),
            title: "乙".into(),
            group: feed.group.clone(),
            new_url: None,
            enabled: None,
            options: Some(crate::models::FeedOptions {
                refresh_minutes: Some(1),
                ..Default::default()
            }),
        })
        .unwrap();
    // Below the shortest interval, it is raised to it.
    assert_eq!(
        guard.feed(&feed.url).unwrap().options.refresh_minutes,
        Some(5)
    );
    guard
        .conn_for_tests()
        .execute(
            "UPDATE rss_feeds SET last_fetch = last_fetch - 6 * 60000 WHERE url = ?1",
            [&feed.url],
        )
        .unwrap();
    assert_eq!(
        guard.refresh_targets(&[], true, 60).unwrap(),
        std::slice::from_ref(&feed.url)
    );
    // Manually refreshing all takes every enabled feed.
    assert_eq!(guard.refresh_targets(&[], false, 0).unwrap().len(), 3);

    // Groups: arranged, renamed into another, and removed.
    guard
        .save_feed_groups(&["乙".into(), "空".into(), "甲".into()])
        .unwrap();
    let names = |guard: &Storage| -> Vec<String> {
        guard
            .feed_groups()
            .unwrap()
            .into_iter()
            .map(|group| group.name)
            .collect()
    };
    assert_eq!(names(&guard), ["乙", "空", "甲"]);
    guard.rename_feed_group("甲", "乙").unwrap();
    assert_eq!(names(&guard), ["乙", "空"]);
    assert_eq!(
        guard
            .feed("https://a.example/feed")
            .unwrap()
            .group
            .as_deref(),
        Some("乙")
    );
    guard.remove_feed_group("乙", false).unwrap();
    assert_eq!(names(&guard), ["空"]);
    assert_eq!(guard.list_feeds().unwrap().len(), 3);
    assert!(guard
        .list_feeds()
        .unwrap()
        .iter()
        .all(|feed| feed.group.is_none()));
    guard.save_feed_groups(&["丙".into()]).unwrap();
    guard
        .update_feed(&crate::models::UpdateFeedRequest {
            url: "https://c.example/feed".into(),
            title: "丙".into(),
            group: Some("丙".into()),
            new_url: None,
            enabled: None,
            options: None,
        })
        .unwrap();
    guard.remove_feed_group("丙", true).unwrap();
    assert_eq!(guard.list_feeds().unwrap().len(), 2);
}

#[test]
fn a_page_the_device_cannot_reach_is_read_by_the_server() {
    let base = start(|request: &Request| match request.path.as_str() {
        "/feed" => Response::bytes(
            "application/rss+xml",
            r#"<rss version="2.0"><channel><title>甲</title>
            <item><title>一</title><link>http://127.0.0.1:1/unreachable</link><guid>1</guid></item>
            </channel></rss>"#
                .as_bytes()
                .to_vec(),
        ),
        _ => Response::not_found(),
    });
    let (_dir, storage) = library();
    subscribe(&storage, &format!("{base}/feed"), None, None).unwrap();
    let id = lock(&storage)
        .unwrap()
        .list_articles(&ArticleQuery::default())
        .unwrap()
        .articles[0]
        .id
        .clone();
    let asked = AtomicU32::new(0);
    let server = |link: &str| {
        asked.fetch_add(1, Ordering::AcqRel);
        assert!(link.ends_with("/unreachable"));
        Ok("<p>服务器读到的正文</p>".to_string())
    };
    // Without a server the error stands; with one, the server reads it.
    assert!(full_text(&storage, &id, None).is_err());
    assert_eq!(
        full_text(&storage, &id, Some(&server)).unwrap(),
        "<p>服务器读到的正文</p>"
    );
    assert_eq!(asked.load(Ordering::Acquire), 1);
    assert_eq!(
        lock(&storage)
            .unwrap()
            .rss_article(&id)
            .unwrap()
            .full_text
            .as_deref(),
        Some("<p>服务器读到的正文</p>")
    );
}

#[test]
fn clearing_articles_keeps_unread_and_starred_and_does_not_bring_read_ones_back() {
    let (_dir, storage) = library();
    let mut guard = lock(&storage).unwrap();
    let url = "https://a.example/feed";
    guard.add_feed(url, "", None, None).unwrap();
    guard.store_feed_fetch(url, &fetched(4, 1_000)).unwrap();
    guard
        .set_article_state(&["0000".into(), "0001".into()], Some(true), None, None)
        .unwrap();
    guard
        .set_article_state(&["0001".into()], None, Some(true), None)
        .unwrap();
    guard.save_full_text("0002", "<p>全文</p>").unwrap();
    let before = guard.rss_article_bytes().unwrap();
    guard.clear_rss_articles().unwrap();
    assert!(guard.rss_article_bytes().unwrap() < before);
    assert!(guard.rss_article("0000").is_err());
    assert!(guard.rss_article("0001").unwrap().summary.starred);
    assert_eq!(guard.rss_article("0002").unwrap().full_text, None);
    // The feed still carries the cleared article: it stays gone.
    assert_eq!(guard.store_feed_fetch(url, &fetched(4, 1_000)).unwrap(), 0);
    assert!(guard.rss_article("0000").is_err());
    assert_eq!(guard.list_feeds().unwrap()[0].total, 3);
}

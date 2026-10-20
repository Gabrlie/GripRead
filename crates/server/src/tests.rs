use super::*;
use axum::http::Request;
use http_body_util::BodyExt;
use tower::ServiceExt;

struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("gripread-server-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn server(folder: &Folder, password: Option<&str>) -> Router {
    let web = folder.0.join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(
        web.join("index.html"),
        "<!doctype html><title>GripRead</title>",
    )
    .unwrap();
    std::fs::write(web.join("assets/app.js"), "console.log(1)").unwrap();
    app(Config {
        data: folder.0.join("data"),
        web: Some(web),
        password: password.map(str::to_string),
    })
    .unwrap()
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

fn post(uri: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut request = Request::post(uri).header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    request.body(Body::from(body.to_string())).unwrap()
}

fn json_of(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap()
}

async fn rpc_call(app: &Router, token: &str, name: &str, args: Value) -> (StatusCode, Value) {
    let (status, _, body) = send(app, post(&format!("/api/rpc/{name}"), Some(token), args)).await;
    (
        status,
        if body.is_empty() {
            Value::Null
        } else {
            json_of(&body)
        },
    )
}

#[tokio::test]
async fn first_run_signs_in_and_commands_need_a_session() {
    let folder = Folder::new();
    let app = server(&folder, None);
    let (_, _, body) = send(
        &app,
        Request::get("/api/auth/status")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(json_of(&body)["configured"], false);

    let (status, _, _) = send(&app, post("/api/rpc/list_groups", None, Value::Null)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, headers, body) = send(
        &app,
        post(
            "/api/auth/setup",
            None,
            json!({ "password": "secret1", "device": "浏览器" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = headers[header::SET_COOKIE].to_str().unwrap().to_string();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    let token = json_of(&body)["token"].as_str().unwrap().to_string();

    // The cookie alone signs the page in.
    let pair = cookie.split(';').next().unwrap().to_string();
    let request = Request::post("/api/rpc/list_groups")
        .header(header::COOKIE, pair)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&app, request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_of(&body), json!([]));

    let (status, created) = rpc_call(
        &app,
        &token,
        "create_group",
        json!({ "request": { "name": "收藏" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["name"], "收藏");
    let (status, failed) = rpc_call(&app, &token, "no_such_command", Value::Null).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(failed["code"], "invalid_argument");

    let (status, _, _) = send(
        &app,
        post("/api/auth/setup", None, json!({ "password": "another1" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _, _) = send(
        &app,
        post("/api/auth/login", None, json!({ "password": "wrong" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A route the server lacks is a JSON error, not the page; other paths
    // still get the page.
    let (status, headers, body) = send(
        &app,
        Request::get("/api/no/such/route")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    assert_eq!(json_of(&body)["code"], "not_found");
    let (status, _, body) = send(&app, Request::get("/shelf").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(String::from_utf8_lossy(&body).starts_with("<!doctype html>"));

    let (_, _, body) = send(
        &app,
        Request::get("/api/auth/sessions")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let sessions = json_of(&body);
    assert_eq!(sessions[0]["device"], "浏览器");
    assert_eq!(sessions[0]["current"], true);
    assert!(sessions[0].get("tokenHash").is_none());
}

#[tokio::test]
async fn uploads_import_and_other_paths_are_refused() {
    let folder = Folder::new();
    let app = server(&folder, Some("secret1"));
    let (_, _, body) = send(
        &app,
        post("/api/auth/login", None, json!({ "password": "secret1" })),
    )
    .await;
    let token = json_of(&body)["token"].as_str().unwrap().to_string();

    let text =
        "第一章 开始\n\u{3000}\u{3000}正文第一段。\n第二章 继续\n\u{3000}\u{3000}正文第二段。\n";
    let request = Request::post("/api/upload?name=%E6%B5%8B%E8%AF%95.txt")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(text))
        .unwrap();
    let (status, _, body) = send(&app, request).await;
    assert_eq!(status, StatusCode::OK);
    let uploaded = json_of(&body);
    let path = uploaded["path"].as_str().unwrap().to_string();
    assert!(path.starts_with("upload:") && path.ends_with("/测试.txt"));

    let (status, task) = rpc_call(
        &app,
        &token,
        "start_import",
        json!({ "request": { "path": path } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{task}");
    let operation = task["operationId"].as_str().unwrap().to_string();
    let mut phase = String::new();
    for _ in 0..200 {
        let (_, status) = rpc_call(
            &app,
            &token,
            "get_import_status",
            json!({ "request": { "operationId": operation } }),
        )
        .await;
        phase = status["phase"].as_str().unwrap_or_default().to_string();
        if matches!(phase.as_str(), "completed" | "failed" | "cancelled") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(phase, "completed");
    let (_, books) = rpc_call(&app, &token, "list_books", Value::Null).await;
    assert_eq!(books[0]["book"]["title"], "测试");

    let (status, refused) = rpc_call(
        &app,
        &token,
        "start_import",
        json!({ "request": { "path": "/etc/hostname" } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refused["code"], "invalid_argument");
    let (status, _) = rpc_call(
        &app,
        &token,
        "list_txt_folder",
        json!({ "request": { "path": "" } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn saved_files_download_once() {
    let folder = Folder::new();
    let app = server(&folder, Some("secret1"));
    let (_, _, body) = send(
        &app,
        post("/api/auth/login", None, json!({ "password": "secret1" })),
    )
    .await;
    let token = json_of(&body)["token"].as_str().unwrap().to_string();
    let (status, saved) = rpc_call(
        &app,
        &token,
        "export_book_sources_file",
        json!({ "request": { "urls": [], "path": null } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved, true);
    let download = || {
        Request::get("/api/export")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let (status, headers, body) = send(&app, download()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .contains("bookSource.json"));
    assert_eq!(json_of(&body), json!([]));
    let (status, _, _) = send(&app, download()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_page_is_served_for_its_routes() {
    let folder = Folder::new();
    let app = server(&folder, None);
    for uri in ["/", "/settings/network"] {
        let (status, _, body) = send(&app, Request::get(uri).body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert!(String::from_utf8_lossy(&body).contains("<title>GripRead</title>"));
    }
    let (_, headers, body) = send(
        &app,
        Request::get("/assets/app.js").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(body, b"console.log(1)");
    assert!(headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
}

#[tokio::test]
async fn devices_push_records_and_files_and_pull_the_web_versions_edits() {
    use gripread_core::storage::Storage;
    use gripread_core::sync::{PullReply, PushReply};
    let folder = Folder::new();
    let app = server(&folder, Some("secret1"));
    let (_, _, body) = send(
        &app,
        post(
            "/api/auth/login",
            None,
            json!({ "password": "secret1", "device": "手机" }),
        ),
    )
    .await;
    let token = json_of(&body)["token"].as_str().unwrap().to_string();

    // A device with a book it renamed.
    let text = "第一章 开始\n头发里的云\n第二章 结束\n后来门开了。";
    let file = folder.0.join("book.txt");
    std::fs::write(&file, text).unwrap();
    let mut phone = Storage::open(&folder.0.join("phone")).unwrap();
    let book = phone
        .import_txt(
            &file,
            "phone-import",
            &std::sync::atomic::AtomicBool::new(false),
            |_, _, _| {},
        )
        .unwrap()
        .book;
    phone
        .update_book(&gripread_core::models::UpdateBookRequest {
            book_id: book.id.clone(),
            title: "云海".into(),
            author: None,
            intro: None,
        })
        .unwrap();
    let changes = phone.sync_pending().unwrap();
    let sha = changes
        .iter()
        .find_map(|change| change.key.strip_prefix("book:"))
        .unwrap()
        .to_string();

    let (status, _, body) = send(
        &app,
        post(
            "/api/sync/push",
            Some(&token),
            json!({ "device": "phone-id", "changes": changes }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let reply: PushReply = serde_json::from_slice(&body).unwrap();
    assert_eq!(reply.missing_books, std::slice::from_ref(&sha));

    // A file that is not the book is refused; the book itself imports and takes its record.
    let put = |bytes: Vec<u8>| {
        Request::put(format!("/api/blobs/book/{sha}"))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(bytes))
            .unwrap()
    };
    let (status, _, _) = send(&app, put(b"something else".to_vec())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, body) = send(&app, put(text.as_bytes().to_vec())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_of(&body)["imported"], true);
    let (_, books) = rpc_call(&app, &token, "list_books", Value::Null).await;
    assert_eq!(books[0]["book"]["title"], "云海");
    let on_server = books[0]["book"]["id"].as_str().unwrap().to_string();

    let pull = |since: i64| {
        Request::get(format!("/api/sync/pull?since={since}"))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let (_, _, body) = send(&app, pull(0)).await;
    let pulled: PullReply = serde_json::from_slice(&body).unwrap();
    assert!(pulled
        .changes
        .iter()
        .any(|change| change.key == format!("book:{sha}") && change.device == "phone-id"));
    let cursor = pulled.head;

    // The web version renames it; once its edits pause, the log has it.
    let (status, _) = rpc_call(
        &app,
        &token,
        "update_book",
        json!({ "request": { "bookId": on_server, "title": "云海新编", "author": null, "intro": null } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut renamed = false;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let (_, _, body) = send(&app, pull(cursor)).await;
        let pulled: PullReply = serde_json::from_slice(&body).unwrap();
        renamed = pulled.changes.iter().any(|change| {
            change.device == "server"
                && change
                    .value
                    .as_ref()
                    .is_some_and(|value| value["title"] == "云海新编")
        });
        if renamed {
            break;
        }
    }
    assert!(renamed, "the web version's edit reached the log");

    let (status, _, body) = send(
        &app,
        Request::get(format!("/api/blobs/book/{sha}"))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, text.as_bytes());
    let (status, _, _) = send(
        &app,
        Request::get(format!("/api/blobs/book/{sha}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_syncs_with_a_running_server_both_ways() {
    let folder = Folder::new();
    let app = server(&folder, Some("secret1"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    // A phone with a book it renamed connects.
    let phone = AppState::open(
        folder.0.join("phone"),
        Arc::new(api::NoEvents),
        Arc::new(gripread_core::platform::Filesystem),
    )
    .unwrap();
    let file = folder.0.join("剑来.txt");
    std::fs::write(&file, "第一章 开始\n头发里的云\n第二章 结束\n后来门开了。").unwrap();
    let book_id = {
        let mut storage = phone.storage.lock().unwrap();
        let id = storage
            .import_txt(
                &file,
                "phone",
                &std::sync::atomic::AtomicBool::new(false),
                |_, _, _| {},
            )
            .unwrap()
            .book
            .id;
        storage
            .update_book(&gripread_core::models::UpdateBookRequest {
                book_id: id.clone(),
                title: "云海".into(),
                author: None,
                intro: None,
            })
            .unwrap();
        id
    };
    let sync = phone.sync.clone();
    let request = gripread_core::models::ConnectSyncServerRequest {
        address: address.clone(),
        password: "secret1".into(),
        device_name: "手机".into(),
    };
    let status = tokio::task::spawn_blocking(move || {
        let status = sync.connect(&request).unwrap();
        sync.sync_and_wait(std::time::Duration::from_secs(20));
        status
    })
    .await
    .unwrap();
    assert!(status.connected);
    assert_eq!(phone.sync.status().last_error, None);

    // The server's library has the book, file and all, under its new name.
    let app = server_client(&address);
    let token = app.login().await;
    let books = app.rpc(&token, "list_books").await;
    assert_eq!(books[0]["book"]["title"], "云海");
    let on_server = books[0]["book"]["id"].as_str().unwrap().to_string();

    // 云书架 on the phone lists the server's copy, which downloads whole.
    let sync = phone.sync.clone();
    let target = folder.0.join("download.txt");
    let (listed, downloaded) = tokio::task::spawn_blocking(move || {
        let listed = sync.server_books().unwrap();
        sync.download_server_book(&listed[0].sha256, &target)
            .unwrap();
        (listed, std::fs::read_to_string(&target).unwrap())
    })
    .await
    .unwrap();
    assert_eq!((listed.len(), listed[0].title.as_str()), (1, "云海"));
    assert!(!listed[0].epub && listed[0].size > 0);
    assert!(downloaded.starts_with("第一章 开始"));

    // The web version renames it; the phone has it after its next event
    // (here returning to the foreground).
    app.rpc_with(
        &token,
        "update_book",
        json!({ "request": { "bookId": on_server, "title": "云海新编", "author": null, "intro": null } }),
    )
    .await;
    let mut title = String::new();
    for _ in 0..60 {
        phone.sync.set_background(false);
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        title = phone
            .storage
            .lock()
            .unwrap()
            .library_book(&book_id)
            .unwrap()
            .book
            .title;
        if title == "云海新编" {
            break;
        }
    }
    assert_eq!(title, "云海新编");

    // Disconnecting keeps the sign-in; connecting again needs no password.
    let sync = phone.sync.clone();
    let again = tokio::task::spawn_blocking(move || {
        sync.disconnect();
        let kept = sync.status();
        let reconnected = sync.connect(&gripread_core::models::ConnectSyncServerRequest {
            address: kept.address.clone(),
            password: String::new(),
            device_name: kept.device_name.clone(),
        });
        (kept, reconnected)
    })
    .await
    .unwrap();
    assert!(again.0.remembered && !again.0.connected);
    assert_eq!(
        (again.0.address.as_str(), again.0.device_name.as_str()),
        (address.as_str(), "手机")
    );
    assert!(again.1.unwrap().connected);
    phone.sync.forget_login();
    phone.sync.disconnect();
    assert!(!phone.sync.status().remembered);
}

/// Plain HTTP to a running server, for tests of the device client.
struct ServerClient {
    address: String,
    agent: ureq::Agent,
}

fn server_client(address: &str) -> ServerClient {
    ServerClient {
        address: address.to_string(),
        agent: ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into(),
    }
}

impl ServerClient {
    async fn login(&self) -> String {
        let (agent, url) = (
            self.agent.clone(),
            format!("{}/api/auth/login", self.address),
        );
        tokio::task::spawn_blocking(move || {
            let mut response = agent
                .post(&url)
                .header("Content-Type", "application/json")
                .send(json!({ "password": "secret1", "device": "测试" }).to_string())
                .unwrap();
            let body: Value =
                serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap();
            body["token"].as_str().unwrap().to_string()
        })
        .await
        .unwrap()
    }

    async fn rpc(&self, token: &str, name: &str) -> Value {
        self.rpc_with(token, name, Value::Null).await
    }

    async fn rpc_with(&self, token: &str, name: &str, args: Value) -> Value {
        let (agent, url, token) = (
            self.agent.clone(),
            format!("{}/api/rpc/{name}", self.address),
            token.to_string(),
        );
        tokio::task::spawn_blocking(move || {
            let mut response = agent
                .post(&url)
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {token}"))
                .send(if args.is_null() {
                    String::new()
                } else {
                    args.to_string()
                })
                .unwrap();
            let text = response.body_mut().read_to_string().unwrap();
            serde_json::from_str(&text).unwrap_or(Value::Null)
        })
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn the_update_mirror_serves_cached_releases_and_their_files() {
    let folder = Folder::new();
    let app = server(&folder, Some("secret1"));
    // A fresh cache, so nothing reaches GitHub.
    let updates = folder.0.join("data/library/updates");
    std::fs::create_dir_all(updates.join("assets/v0.2.1")).unwrap();
    std::fs::write(
        updates.join("releases.json"),
        json!([{
            "tag_name": "v0.2.1",
            "body": "## 更新内容\n\n- 新版本\n\n## 下载\n\n| x |",
            "prerelease": false,
            "html_url": "https://github.com/x/releases/tag/v0.2.1",
            "assets": [{ "name": "gripread-0.2.1-universal.apk", "size": 3,
                         "browser_download_url": "https://invalid.example/apk" }]
        }])
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        updates.join("assets/v0.2.1/gripread-0.2.1-universal.apk"),
        "apk",
    )
    .unwrap();
    let get = |uri: &str, token: Option<&str>| {
        let mut request = Request::get(uri);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        request.body(Body::empty()).unwrap()
    };
    let (status, _, _) = send(&app, get("/api/update/releases", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (_, _, body) = send(
        &app,
        post("/api/auth/login", None, json!({ "password": "secret1" })),
    )
    .await;
    let token = json_of(&body)["token"].as_str().unwrap().to_string();
    let (status, _, body) = send(&app, get("/api/update/releases", Some(&token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_of(&body)[0]["tag_name"], "v0.2.1");

    let (status, headers, body) = send(
        &app,
        get(
            "/api/update/asset/v0.2.1/gripread-0.2.1-universal.apk",
            Some(&token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_LENGTH], "3");
    assert_eq!(body, b"apk");
    let (status, _, _) = send(
        &app,
        get("/api/update/asset/v0.2.1/..%2Fserver.json", Some(&token)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The web version learns of the new server image.
    let (status, check) = rpc_call(
        &app,
        &token,
        "check_update",
        json!({ "request": { "current": "0.2.0" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{check}");
    assert_eq!(check["kind"], "server");
    assert_eq!(check["update"]["version"], "0.2.1");
    assert_eq!(check["update"]["notes"], "## 更新内容\n\n- 新版本");
}

#[tokio::test]
async fn shelf_jobs_are_set_run_and_answered() {
    let folder = Folder::new();
    let app = server(&folder, Some("secret1"));
    let (_, _, body) = send(
        &app,
        post("/api/auth/login", None, json!({ "password": "secret1" })),
    )
    .await;
    let token = json_of(&body)["token"].as_str().unwrap().to_string();
    let authorized = |request: axum::http::request::Builder| {
        request.header(header::AUTHORIZATION, format!("Bearer {token}"))
    };

    let (status, _, _) = send(&app, Request::get("/api/jobs").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, body) = send(
        &app,
        authorized(Request::get("/api/jobs"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let jobs = json_of(&body);
    assert_eq!(
        jobs["settings"],
        json!({ "intervalHours": 6, "prefetch": 5, "rssIntervalMinutes": 60 })
    );
    assert!(jobs["status"]["nextRun"].is_i64());

    let (status, _, body) = send(
        &app,
        authorized(Request::put("/api/jobs"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "intervalHours": 0, "prefetch": 99, "rssIntervalMinutes": 99_999 })
                    .to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json_of(&body),
        json!({ "intervalHours": 0, "prefetch": 50, "rssIntervalMinutes": 1440 })
    );
    assert!(folder.0.join("data/jobs.json").is_file());

    // With no online books, an update answers at once.
    let (status, _, body) = send(&app, post("/api/jobs/update", Some(&token), json!({}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_of(&body), json!({ "books": [] }));
    let (_, _, body) = send(
        &app,
        authorized(Request::get("/api/jobs"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let status = &json_of(&body)["status"];
    assert!(status["lastRun"].is_i64());
    assert_eq!(status["running"], false);
    assert_eq!(status["failures"], json!([]));

    // A chapter of a book the server does not have.
    let (status, _, _) = send(
        &app,
        authorized(Request::get("/api/sync/chapter?key=x&url=%2Fc%2F1.html"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // 通过服务器访问 never reaches the server's own network.
    let hop = json!({
        "method": "GET",
        "url": "http://127.0.0.1:9/",
        "headers": [["User-Agent", "x"]],
        "body": null,
        "timeoutMs": 2000
    });
    let (status, _, body) = send(
        &app,
        authorized(Request::post("/api/source/fetch"))
            .header("content-type", "application/json")
            .body(Body::from(hop.to_string()))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(json_of(&body)["message"].as_str().unwrap().contains("内网"));
    let (status, _, _) = send(
        &app,
        Request::post("/api/source/fetch")
            .header("content-type", "application/json")
            .body(Body::from(hop.to_string()))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connected_device_refreshes_its_feeds_through_the_server() {
    // A feed that grows by one article each time it is fetched.
    let fetched = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let count = fetched.clone();
    let pages = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let page_hits = pages.clone();
    let site_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", site_listener.local_addr().unwrap());
    let feed = format!("{base}/feed");
    let link = format!("{base}/page");
    let site = Router::new()
        .route(
            "/feed",
            get(move || {
                let round = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let items: String = (1..=round)
                    .map(|n| format!("<item><title>第{n}篇</title><guid>p{n}</guid><link>{link}</link></item>"))
                    .collect();
                async move {
                    (
                        [(header::CONTENT_TYPE, "application/rss+xml")],
                        format!("<rss version=\"2.0\"><channel><title>博客</title>{items}</channel></rss>"),
                    )
                }
            }),
        )
        .route(
            "/page",
            get(move || {
                page_hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let text = "服务器读到的正文。".repeat(40);
                async move {
                    axum::response::Html(format!(
                        "<html><body><nav>导航</nav><article><p>{text}</p><p>{text}</p></article></body></html>"
                    ))
                }
            }),
        );
    tokio::spawn(async move { axum::serve(site_listener, site).await.unwrap() });

    let folder = Folder::new();
    let app = server(&folder, Some("secret1"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let phone = AppState::open(
        folder.0.join("phone"),
        Arc::new(api::NoEvents),
        Arc::new(gripread_core::platform::Filesystem),
    )
    .unwrap();
    let sync = phone.sync.clone();
    let storage = phone.storage.clone();
    let url = feed.clone();
    tokio::task::spawn_blocking(move || {
        sync.connect(&gripread_core::models::ConnectSyncServerRequest {
            address,
            password: "secret1".into(),
            device_name: "手机".into(),
        })
        .unwrap();
        // Subscribing fetches once here; the subscription goes to the server.
        gripread_core::rss::subscribe(&storage, &url, None, None).unwrap();
        sync.now();
        sync.sync_and_wait(std::time::Duration::from_secs(20));
    })
    .await
    .unwrap();

    // The phone's refresh asks the server, which fetches and hands over
    // the new article.
    gripread_core::rss_commands::refresh_feeds(
        &phone,
        gripread_core::models::RefreshFeedsRequest {
            operation_id: "rss-test".into(),
            urls: Vec::new(),
            due: false,
        },
    )
    .await
    .unwrap();
    let (id, feed_title) = {
        let guard = phone.storage.lock().unwrap();
        let feeds = guard.list_feeds().unwrap();
        assert_eq!((feeds[0].title.as_str(), feeds[0].total), ("博客", 2));
        assert!(guard.feed_server_cursor(&feed).unwrap() > 0);
        let id = guard.list_articles(&Default::default()).unwrap().articles[0]
            .id
            .clone();
        (id, feeds[0].title.clone())
    };
    assert_eq!(fetched.load(std::sync::atomic::Ordering::SeqCst), 2);

    // A feed set to read 全文 through the server: the server reads the page.
    {
        let mut guard = phone.storage.lock().unwrap();
        guard
            .update_feed(&gripread_core::models::UpdateFeedRequest {
                url: feed.clone(),
                title: feed_title,
                group: None,
                new_url: None,
                enabled: None,
                options: Some(gripread_core::models::FeedOptions {
                    via_server: true,
                    ..Default::default()
                }),
            })
            .unwrap();
    }
    // The page is on this machine, which the server does not read for
    // others (as with 通过服务器访问): the refusal comes back, unread.
    let error = gripread_core::rss_commands::fetch_full_text(
        &phone,
        gripread_core::models::ArticleIdRequest { id },
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("内网"), "{}", error.message);
    assert_eq!(pages.load(std::sync::atomic::Ordering::SeqCst), 0);
}

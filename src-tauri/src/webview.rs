//! The app's WebView for book sources (sources::webview): on Android a
//! native plugin renders pages off screen and shows login and
//! verification pages; elsewhere no host is installed and such sources say
//! they need WebView.

/// Registers the Android plugin and installs it as the engine's WebView.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("gripread-webview")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    _api.register_android_plugin("com.gripread.reader", "WebViewPlugin")?;
                gripread_core::sources::webview::set_host(Some(std::sync::Arc::new(
                    android::Host::new(handle),
                )));
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
mod android {
    use gripread_core::sources::webview::{BrowseRequest, WebRequest, WebResult, WebViewHost};
    use std::sync::{Condvar, Mutex};

    /// Pages rendered at once; more wait their turn.
    const AT_ONCE: usize = 2;

    pub struct Host<R: tauri::Runtime> {
        handle: tauri::plugin::PluginHandle<R>,
        busy: Mutex<usize>,
        free: Condvar,
    }

    impl<R: tauri::Runtime> Host<R> {
        pub fn new(handle: tauri::plugin::PluginHandle<R>) -> Self {
            Self {
                handle,
                busy: Mutex::new(0),
                free: Condvar::new(),
            }
        }
    }

    #[derive(serde::Deserialize)]
    struct Answer {
        url: String,
        body: String,
        cookies: Option<String>,
    }

    fn headers(list: &[(String, String)]) -> serde_json::Map<String, serde_json::Value> {
        list.iter()
            .map(|(key, value)| (key.clone(), serde_json::Value::String(value.clone())))
            .collect()
    }

    impl<R: tauri::Runtime> WebViewHost for Host<R> {
        fn render(&self, request: &WebRequest) -> Result<WebResult, String> {
            {
                let mut busy = self.busy.lock().map_err(|_| "WebView 不可用".to_string())?;
                while *busy >= AT_ONCE {
                    busy = self
                        .free
                        .wait(busy)
                        .map_err(|_| "WebView 不可用".to_string())?;
                }
                *busy += 1;
            }
            let payload = serde_json::json!({
                "url": request.url,
                "html": request.html,
                "headers": headers(&request.headers),
                "js": request.js,
                "sourceRegex": request.source_regex,
                "overrideUrlRegex": request.override_url_regex,
                "delayMs": request.delay_ms,
                "timeoutMs": request.timeout_ms.max(1_000),
            });
            let answer = self
                .handle
                .run_mobile_plugin::<Answer>("render", payload)
                .map_err(|error| error.to_string());
            if let Ok(mut busy) = self.busy.lock() {
                *busy -= 1;
            }
            self.free.notify_one();
            let answer = answer?;
            Ok(WebResult {
                url: answer.url,
                body: answer.body,
                cookies: answer.cookies,
            })
        }

        fn browse(&self, request: &BrowseRequest) -> Result<WebResult, String> {
            let payload = serde_json::json!({
                "url": request.url,
                "title": request.title,
                "headers": headers(&request.headers),
                "html": request.html,
            });
            let answer = self
                .handle
                .run_mobile_plugin::<Answer>("browse", payload)
                .map_err(|error| error.to_string())?;
            Ok(WebResult {
                url: answer.url,
                body: answer.body,
                cookies: answer.cookies,
            })
        }

        fn browse_watch(
            &self,
            request: &BrowseRequest,
            check: &mut dyn FnMut(&WebResult) -> bool,
        ) -> Result<WebResult, String> {
            #[derive(serde::Deserialize)]
            struct Opened {
                id: i64,
            }
            #[derive(serde::Deserialize)]
            struct State {
                url: String,
                body: String,
                cookies: Option<String>,
                closed: bool,
            }
            let payload = serde_json::json!({
                "url": request.url,
                "title": request.title,
                "headers": headers(&request.headers),
                "html": request.html,
                "doneLabel": "完成登录",
            });
            let id = self
                .handle
                .run_mobile_plugin::<Opened>("browseOpen", payload)
                .map_err(|error| error.to_string())?
                .id;
            let started = std::time::Instant::now();
            let mut seen: Option<(String, Option<String>)> = None;
            loop {
                std::thread::sleep(POLL);
                let state = self
                    .handle
                    .run_mobile_plugin::<State>("browseState", serde_json::json!({ "id": id }))
                    .map_err(|error| error.to_string())?;
                let result = WebResult {
                    url: state.url.clone(),
                    body: state.body,
                    cookies: state.cookies.clone(),
                };
                if state.closed {
                    return Ok(result);
                }
                let now = (state.url, state.cookies);
                if seen.as_ref() == Some(&now) && started.elapsed() < WATCH_LIMIT {
                    continue;
                }
                seen = Some(now);
                if check(&result) || started.elapsed() >= WATCH_LIMIT {
                    let last = self
                        .handle
                        .run_mobile_plugin::<State>("browseClose", serde_json::json!({ "id": id }))
                        .map_err(|error| error.to_string())?;
                    return Ok(WebResult {
                        url: last.url,
                        body: last.body,
                        cookies: last.cookies.or(result.cookies),
                    });
                }
            }
        }
    }

    /// How often an open login page is looked at, and how long at most.
    const POLL: std::time::Duration = std::time::Duration::from_millis(800);
    const WATCH_LIMIT: std::time::Duration = std::time::Duration::from_secs(15 * 60);
}

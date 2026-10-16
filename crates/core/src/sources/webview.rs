//! The WebView a source can ask for, as Legado's BackstageWebView and
//! WebViewActivity: `render` loads a page off screen and returns its HTML
//! or a script's result; `browse` shows a page for the reader to log in or
//! pass a verification, and returns when they close it. The app installs a
//! host (Android's WebView); without one, sources that need it fail with
//! an explicit unsupported error. Cookies a page sets go to the source's
//! cookie store.

use super::context::Env;
use super::error::{SourceError, SourceResult};
use super::http::{cookie_domain, merge_cookies};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

/// The longest a page may take to render.
pub const RENDER_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebRequest {
    pub url: String,
    /// HTML to load at `url` instead of fetching it (a POST answer, or java.webView's html).
    pub html: Option<String>,
    pub headers: Vec<(String, String)>,
    /// Runs once the page has loaded; its result is the body. Without it the
    /// body is the page's HTML.
    pub js: Option<String>,
    /// The first loaded resource whose address matches becomes the body.
    pub source_regex: Option<String>,
    /// The first navigation whose address matches becomes the body.
    pub override_url_regex: Option<String>,
    /// Extra wait after the page loads, in milliseconds.
    pub delay_ms: u64,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebResult {
    /// The page's address when it finished.
    pub url: String,
    pub body: String,
    /// The page's cookies for its address, as a `Cookie` header.
    pub cookies: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrowseRequest {
    pub url: String,
    pub title: String,
    pub headers: Vec<(String, String)>,
    pub html: Option<String>,
}

pub trait WebViewHost: Send + Sync {
    /// Blocks until the page is ready or `timeout_ms` passes; errors are messages.
    fn render(&self, request: &WebRequest) -> Result<WebResult, String>;
    /// Blocks until the reader closes the page.
    fn browse(&self, request: &BrowseRequest) -> Result<WebResult, String>;
    /// As `browse`, and while the page is open calls `check` with its state
    /// whenever its address or cookies change; the page closes as soon as
    /// `check` answers true. Hosts that cannot watch a page just browse.
    fn browse_watch(
        &self,
        request: &BrowseRequest,
        _check: &mut dyn FnMut(&WebResult) -> bool,
    ) -> Result<WebResult, String> {
        self.browse(request)
    }
}

static HOST: RwLock<Option<Arc<dyn WebViewHost>>> = RwLock::new(None);

/// Installs the app's WebView; `None` removes it.
pub fn set_host(host: Option<Arc<dyn WebViewHost>>) {
    if let Ok(mut current) = HOST.write() {
        *current = host;
    }
}

pub fn host() -> Option<Arc<dyn WebViewHost>> {
    #[cfg(test)]
    if let Some(host) = testing::HOST.with(|host| host.borrow().clone()) {
        return Some(host);
    }
    HOST.read().ok().and_then(|host| host.clone())
}

fn missing() -> SourceError {
    SourceError::unsupported("需要 WebView，暂不支持")
}

/// The request's cookies with the stored ones, so the page sees the session.
fn with_cookies(env: &Env, url: &str, headers: &mut Vec<(String, String)>) {
    if !env.source.enabled_cookie_jar() {
        return;
    }
    let Some(stored) = env.store.cookie_get(&cookie_domain(url)) else {
        return;
    };
    match headers
        .iter_mut()
        .find(|(key, _)| key.eq_ignore_ascii_case("cookie"))
    {
        Some((_, value)) => *value = merge_cookies(&stored, value),
        None => headers.push(("Cookie".into(), stored)),
    }
}

/// Keeps the cookies a page set, for later requests to its site.
fn keep_cookies(env: &Env, result: &WebResult) {
    let Some(cookies) = result
        .cookies
        .as_deref()
        .filter(|cookies| !cookies.is_empty())
    else {
        return;
    };
    let domain = cookie_domain(&result.url);
    let merged = match env.store.cookie_get(&domain) {
        Some(stored) => merge_cookies(&stored, cookies),
        None => cookies.to_string(),
    };
    env.store.cookie_put(&domain, &merged);
}

/// Renders a page for the engine, bounded by the operation's deadline.
pub fn render(env: &Env, mut request: WebRequest) -> SourceResult<WebResult> {
    let host = host().ok_or_else(missing)?;
    env.control.check()?;
    with_cookies(env, &request.url, &mut request.headers);
    let limit = env
        .control
        .deadline
        .map(|deadline| deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(RENDER_TIMEOUT)
        .min(RENDER_TIMEOUT);
    request.timeout_ms = limit.as_millis() as u64;
    env.log(format!("WebView 打开 {}", request.url));
    let started = Instant::now();
    let result = host
        .render(&request)
        .map_err(|message| SourceError::network(format!("WebView：{message}")))?;
    env.log(format!(
        "WebView 完成 {}（{} ms）",
        result.url,
        started.elapsed().as_millis()
    ));
    env.control.check()?;
    keep_cookies(env, &result);
    Ok(result)
}

/// Shows a login page and closes it once `check` (run after keeping the
/// page's cookies) answers true; answers the last state and whether the
/// check passed while the page was open.
pub fn browse_until(
    env: &Env,
    mut request: BrowseRequest,
    mut check: impl FnMut(&WebResult) -> bool,
) -> SourceResult<(WebResult, bool)> {
    let host = host().ok_or_else(missing)?;
    with_cookies(env, &request.url, &mut request.headers);
    env.log(format!("打开网页 {}", request.url));
    let mut passed = false;
    let result = host
        .browse_watch(&request, &mut |state| {
            keep_cookies(env, state);
            passed = check(state);
            passed
        })
        .map_err(|message| SourceError::network(format!("网页：{message}")))?;
    keep_cookies(env, &result);
    Ok((result, passed))
}

/// Shows a page to the reader (登录, 验证) and waits until they close it.
pub fn browse(env: &Env, mut request: BrowseRequest) -> SourceResult<WebResult> {
    let host = host().ok_or_else(missing)?;
    with_cookies(env, &request.url, &mut request.headers);
    env.log(format!("打开网页 {}", request.url));
    let result = host
        .browse(&request)
        .map_err(|message| SourceError::network(format!("网页：{message}")))?;
    keep_cookies(env, &result);
    Ok(result)
}

#[cfg(test)]
pub mod testing {
    //! A host that answers from a closure, for engine tests.
    use super::*;
    use std::sync::Mutex;

    type Answer = Box<dyn Fn(&WebRequest) -> Result<WebResult, String> + Send + Sync>;

    pub struct FakeHost {
        pub answer: Answer,
        pub seen: Mutex<Vec<WebRequest>>,
        /// States a watched page goes through before the reader closes it.
        pub pages: Mutex<Vec<WebResult>>,
        /// How many of them the check saw.
        pub checked: Mutex<usize>,
    }

    impl WebViewHost for FakeHost {
        fn render(&self, request: &WebRequest) -> Result<WebResult, String> {
            self.seen.lock().unwrap().push(request.clone());
            (self.answer)(request)
        }

        fn browse(&self, request: &BrowseRequest) -> Result<WebResult, String> {
            Ok(WebResult {
                url: request.url.clone(),
                body: "<html>done</html>".into(),
                cookies: Some("token=abc".into()),
            })
        }

        fn browse_watch(
            &self,
            request: &BrowseRequest,
            check: &mut dyn FnMut(&WebResult) -> bool,
        ) -> Result<WebResult, String> {
            for page in self.pages.lock().unwrap().iter() {
                *self.checked.lock().unwrap() += 1;
                if check(page) {
                    return Ok(page.clone());
                }
            }
            self.browse(request)
        }
    }

    thread_local! {
        pub static HOST: std::cell::RefCell<Option<Arc<dyn WebViewHost>>> =
            const { std::cell::RefCell::new(None) };
    }

    /// Runs `work` with `host` as this thread's WebView.
    pub fn with_host<R>(host: Arc<FakeHost>, work: impl FnOnce() -> R) -> R {
        HOST.with(|slot| *slot.borrow_mut() = Some(host));
        let result = work();
        HOST.with(|slot| *slot.borrow_mut() = None);
        result
    }

    pub fn fake(
        answer: impl Fn(&WebRequest) -> Result<WebResult, String> + Send + Sync + 'static,
    ) -> Arc<FakeHost> {
        Arc::new(FakeHost {
            answer: Box::new(answer),
            seen: Mutex::new(Vec::new()),
            pages: Mutex::new(Vec::new()),
            checked: Mutex::new(0),
        })
    }
}

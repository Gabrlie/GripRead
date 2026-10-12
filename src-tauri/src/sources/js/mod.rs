//! The QuickJS host that runs source scripts synchronously, as Rhino does in
//! Legado: `java.ajax` and the other host calls block and return values,
//! and a script's last expression is its result.
//!
//! One host serves one operation on one thread. Scripts see Legado's
//! bindings (`java`, `source`, `book`, `chapter`, `result`, `src`,
//! `baseUrl`, `title`, `nextChapterUrl`, `key`, `page`, `cookie`, `cache`)
//! and the source's `jsLib`, and nothing of the application beyond them.

mod api;
pub mod crypto;
mod rhino;

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use rquickjs::function::Args;
use rquickjs::{Array, Context, Ctx, Function, Object, Runtime, Value};

use super::context::{BookData, ChapterData, Env};
use super::dom::Element;
use super::error::{SourceError, SourceResult};
use super::http::HttpResponse;
use super::rule::analyze::{AnalyzeRule, Scripts};
use super::url::{UrlBindings, UrlScripts};
use super::value::{format_f64, Val};

const PRELUDE: &str = include_str!("prelude.js");
const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
const STACK_LIMIT: usize = 4 * 1024 * 1024;

pub(crate) struct HostState {
    pub env: Rc<Env>,
    /// The analyzer for scripts that run outside any rule, such as jsLib.
    pub base_rule: AnalyzeRule,
    /// The analyzers whose scripts are running, innermost last; `java` is
    /// the innermost.
    pub stack: RefCell<Vec<AnalyzeRule>>,
    /// Elements handed to scripts, addressed by index.
    pub elements: RefCell<Vec<Element>>,
    initialized: Cell<bool>,
}

impl HostState {
    pub fn rule(&self) -> AnalyzeRule {
        self.stack
            .borrow()
            .last()
            .cloned()
            .unwrap_or_else(|| self.base_rule.clone())
    }

    pub fn register(&self, element: Element) -> i32 {
        let mut elements = self.elements.borrow_mut();
        elements.push(element);
        (elements.len() - 1) as i32
    }

    pub fn element(&self, handle: i32) -> Option<Element> {
        usize::try_from(handle)
            .ok()
            .and_then(|index| self.elements.borrow().get(index).cloned())
    }
}

/// A script runtime for one source operation.
pub struct JsHost {
    // Field order matters: the context is dropped before its runtime.
    context: Context,
    _runtime: Runtime,
    state: Rc<HostState>,
}

impl JsHost {
    pub fn new(env: Rc<Env>) -> SourceResult<Self> {
        let runtime = Runtime::new().map_err(|error| SourceError::script(error.to_string()))?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        runtime.set_max_stack_size(STACK_LIMIT);
        let control = env.control.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            control.is_cancelled() || control.is_expired()
        })));
        let context =
            Context::full(&runtime).map_err(|error| SourceError::script(error.to_string()))?;
        let state = Rc::new(HostState {
            base_rule: AnalyzeRule::new(env.clone()),
            env,
            stack: RefCell::new(Vec::new()),
            elements: RefCell::new(Vec::new()),
            initialized: Cell::new(false),
        });
        Ok(Self {
            context,
            _runtime: runtime,
            state,
        })
    }

    /// Runs `work` with the host's scripts available. The source's jsLib is
    /// loaded on first use.
    pub fn run<R>(
        &self,
        work: impl for<'js> FnOnce(&JsScope<'js>) -> SourceResult<R>,
    ) -> SourceResult<R> {
        self.context.with(|ctx| {
            let scope = JsScope {
                ctx: ctx.clone(),
                state: self.state.clone(),
            };
            if !self.state.initialized.get() {
                self.state.initialized.set(true);
                scope.install()?;
            }
            work(&scope)
        })
    }
}

/// The host inside an operation; it is the [`Scripts`] rules run with.
pub struct JsScope<'js> {
    pub ctx: Ctx<'js>,
    pub(crate) state: Rc<HostState>,
}

/// Evaluates global code in sloppy mode, as Rhino runs source scripts;
/// QuickJS bindings default to strict mode, which rejects `with`.
fn eval_sloppy<'js, V: rquickjs::FromJs<'js>>(
    ctx: &Ctx<'js>,
    code: impl Into<Vec<u8>>,
) -> rquickjs::Result<V> {
    let mut options = rquickjs::context::EvalOptions::default();
    options.strict = false;
    ctx.eval_with_options(code, options)
}

fn script_error<'js>(ctx: &Ctx<'js>, error: rquickjs::Error, env: &Env) -> SourceError {
    if let Err(control) = env.control.check() {
        return control;
    }
    match error {
        rquickjs::Error::Exception => {
            let thrown = ctx.catch();
            let message = thrown
                .as_object()
                .and_then(|object| {
                    let name: Option<String> = object.get("name").ok();
                    let message: Option<String> = object.get("message").ok();
                    message.map(|message| match name {
                        Some(name) if !name.is_empty() => format!("{name}: {message}"),
                        _ => message,
                    })
                })
                .or_else(|| {
                    thrown
                        .get::<rquickjs::Coerced<String>>()
                        .ok()
                        .map(|text| text.0)
                })
                .unwrap_or_else(|| "脚本出错".to_string());
            if message.contains("不支持: java.webView") || message.contains("需要 WebView") {
                return SourceError::unsupported(message);
            }
            SourceError::script(message)
        }
        other => SourceError::script(other.to_string()),
    }
}

impl<'js> JsScope<'js> {
    pub fn env(&self) -> &Rc<Env> {
        &self.state.env
    }

    fn js_error(&self, error: rquickjs::Error) -> SourceError {
        script_error(&self.ctx, error, &self.state.env)
    }

    /// Installs the prelude, the host objects, and the source's jsLib.
    fn install(&self) -> SourceResult<()> {
        let ctx = &self.ctx;
        let globals = ctx.globals();
        let native = Object::new(ctx.clone()).map_err(|e| self.js_error(e))?;
        api::install_natives(ctx, &native, self.state.clone()).map_err(|e| self.js_error(e))?;
        globals
            .set("__native", native)
            .map_err(|e| self.js_error(e))?;
        eval_sloppy::<()>(ctx, PRELUDE).map_err(|e| self.js_error(e))?;
        let java = api::java_object(ctx, self.state.clone()).map_err(|e| self.js_error(e))?;
        globals.set("java", java).map_err(|e| self.js_error(e))?;
        // `java` shadows Rhino's Java package, yet some scripts still write
        // `java.lang.String`; point those names at the shims.
        eval_sloppy::<()>(
            ctx,
            "['lang','util','net','text'].forEach(function(n){java[n]=Packages.java[n]})",
        )
        .map_err(|e| self.js_error(e))?;
        let source = api::source_object(ctx, self.state.clone()).map_err(|e| self.js_error(e))?;
        globals
            .set("source", source)
            .map_err(|e| self.js_error(e))?;
        let cookie = api::cookie_object(ctx, self.state.clone()).map_err(|e| self.js_error(e))?;
        globals
            .set("cookie", cookie)
            .map_err(|e| self.js_error(e))?;
        let cache = api::cache_object(ctx, self.state.clone()).map_err(|e| self.js_error(e))?;
        globals.set("cache", cache).map_err(|e| self.js_error(e))?;
        if let Some(js_lib) = self.state.env.source.js_lib() {
            self.load_js_lib(&js_lib)?;
        }
        Ok(())
    }

    /// jsLib is either code or a JSON object of names to script addresses.
    fn load_js_lib(&self, js_lib: &str) -> SourceResult<()> {
        let trimmed = js_lib.trim();
        let mut scripts = Vec::new();
        if trimmed.starts_with('{') {
            if let Ok(serde_json::Value::Object(map)) =
                serde_json::from_str::<serde_json::Value>(trimmed)
            {
                for (_, value) in map {
                    let address = super::value::json_text(&value);
                    if super::util::is_absolute_url(&address) {
                        scripts.push(api::cache_file(self, &address, 0)?);
                    } else {
                        scripts.push(address);
                    }
                }
            } else {
                scripts.push(js_lib.to_string());
            }
        } else {
            scripts.push(js_lib.to_string());
        }
        for script in scripts {
            let prepared = rhino::prepare(&script);
            eval_sloppy::<()>(&self.ctx, prepared).map_err(|error| {
                let error = self.js_error(error);
                SourceError::script(format!("jsLib 加载失败：{}", error.message))
            })?;
        }
        Ok(())
    }

    pub fn to_js(&self, value: &Val) -> rquickjs::Result<Value<'js>> {
        let ctx = &self.ctx;
        Ok(match value {
            Val::Null => Value::new_null(ctx.clone()),
            Val::Str(text) => rquickjs::String::from_str(ctx.clone(), text)?.into_value(),
            Val::Json(json) => ctx.json_parse(json.to_string())?,
            Val::Element(element) => {
                let handle = self.state.register(element.clone());
                let make: Function = ctx.globals().get("__gr_element")?;
                make.call((handle,))?
            }
            Val::Elements(elements) => {
                let handles = Array::new(ctx.clone())?;
                for (index, element) in elements.iter().enumerate() {
                    handles.set(index, self.state.register(element.clone()))?;
                }
                let make: Function = ctx.globals().get("__gr_elements")?;
                make.call((handles,))?
            }
            Val::List(items) => {
                let array = Array::new(ctx.clone())?;
                for (index, item) in items.iter().enumerate() {
                    array.set(index, self.to_js(item)?)?;
                }
                array.into_value()
            }
        })
    }

    fn element_handle(value: &Value<'js>) -> Option<i32> {
        let object = value.as_object()?;
        object.get::<_, Option<i32>>("__h").ok().flatten()
    }

    pub fn from_js(&self, value: Value<'js>) -> Val {
        if value.is_undefined() || value.is_null() {
            return Val::Null;
        }
        if let Some(flag) = value.as_bool() {
            return Val::Str(flag.to_string());
        }
        if let Some(number) = value.as_number() {
            return Val::Str(format_f64(number));
        }
        if let Some(text) = value.as_string() {
            return Val::Str(text.to_string().unwrap_or_default());
        }
        if value.is_function() {
            return Val::Null;
        }
        if let Some(array) = value.as_array() {
            let items: Vec<Value<'js>> =
                array.iter::<Value<'js>>().filter_map(Result::ok).collect();
            let handles: Vec<i32> = items.iter().filter_map(Self::element_handle).collect();
            if !items.is_empty() && handles.len() == items.len() {
                return Val::Elements(
                    handles
                        .into_iter()
                        .filter_map(|h| self.state.element(h))
                        .collect(),
                );
            }
            return Val::List(items.into_iter().map(|item| self.from_js(item)).collect());
        }
        if let Some(handle) = Self::element_handle(&value) {
            return self.state.element(handle).map_or(Val::Null, Val::Element);
        }
        if let Some(object) = value.as_object() {
            if let Ok(Some(body)) = object.get::<_, Option<String>>("__body") {
                return Val::Str(body);
            }
        }
        match self.ctx.json_stringify(value.clone()) {
            Ok(Some(text)) => {
                let text = text.to_string().unwrap_or_default();
                serde_json::from_str(&text).map_or(Val::Str(text), Val::Json)
            }
            _ => value
                .get::<rquickjs::Coerced<String>>()
                .map_or(Val::Null, |text| Val::Str(text.0)),
        }
    }

    fn book_object(&self, book: &BookData) -> rquickjs::Result<Value<'js>> {
        let make: Function = self.ctx.globals().get("__gr_book")?;
        let fields = self.ctx.json_parse(api::book_fields(book).to_string())?;
        make.call((fields,))
    }

    fn chapter_object(&self, chapter: &ChapterData) -> rquickjs::Result<Value<'js>> {
        let make: Function = self.ctx.globals().get("__gr_chapter")?;
        let fields = self
            .ctx
            .json_parse(api::chapter_fields(chapter).to_string())?;
        make.call((fields,))
    }

    /// Runs a script as `rule`'s `java`, returning its completion value.
    pub fn run_script(
        &self,
        rule: &AnalyzeRule,
        script: &str,
        result: &Val,
        bindings: &UrlBindings,
    ) -> SourceResult<Val> {
        self.state.env.control.check()?;
        let prepared = rhino::prepare(script);
        self.state.stack.borrow_mut().push(rule.clone());
        let outcome = self.call_eval(rule, &prepared, result, bindings);
        self.state.stack.borrow_mut().pop();
        outcome
    }

    /// Runs `loginCheckJs` with the response as `result`; the script may
    /// return the response, another response, or new text.
    pub fn login_check(
        &self,
        rule: &AnalyzeRule,
        script: &str,
        response: HttpResponse,
    ) -> SourceResult<HttpResponse> {
        self.state.env.control.check()?;
        let prepared = rhino::prepare(script);
        let result =
            api::response_object(&self.ctx, &response).map_err(|error| self.js_error(error))?;
        self.state.stack.borrow_mut().push(rule.clone());
        let outcome = self.call_eval_value(rule, &prepared, result, &UrlBindings::default());
        self.state.stack.borrow_mut().pop();
        let value = outcome?;
        let Some(object) = value.as_object() else {
            return Ok(match self.from_js(value) {
                Val::Null => response,
                other => HttpResponse {
                    body: other.to_text(),
                    ..response
                },
            });
        };
        let data: Option<Value<'_>> = object.get("__data").ok();
        match data.and_then(|data| self.ctx.json_stringify(data).ok().flatten()) {
            Some(text) => {
                let data: serde_json::Value =
                    serde_json::from_str(&text.to_string().unwrap_or_default()).unwrap_or_default();
                Ok(HttpResponse {
                    url: data["url"].as_str().unwrap_or(&response.url).to_string(),
                    code: data["code"]
                        .as_u64()
                        .map_or(response.code, |code| code as u16),
                    body: data["body"].as_str().unwrap_or("").to_string(),
                    ..response
                })
            }
            None => Ok(HttpResponse {
                body: self.from_js(value).to_text(),
                ..response
            }),
        }
    }

    fn call_eval(
        &self,
        rule: &AnalyzeRule,
        script: &str,
        result: &Val,
        bindings: &UrlBindings,
    ) -> SourceResult<Val> {
        let result = self.to_js(result).map_err(|error| self.js_error(error))?;
        let value = self.call_eval_value(rule, script, result, bindings)?;
        Ok(self.from_js(value))
    }

    fn call_eval_value(
        &self,
        rule: &AnalyzeRule,
        script: &str,
        result_value: Value<'js>,
        bindings: &UrlBindings,
    ) -> SourceResult<Value<'js>> {
        let ctx = &self.ctx;
        let globals = ctx.globals();
        let run = || -> rquickjs::Result<(Value<'js>, Option<Value<'js>>, Option<Value<'js>>)> {
            let evaluate: Function = globals.get("__gr_eval")?;
            let book = match rule.book() {
                Some(book) => Some(self.book_object(&book.borrow())?),
                None => None,
            };
            let chapter = match rule.chapter() {
                Some(chapter) => Some(self.chapter_object(&chapter.borrow())?),
                None => None,
            };
            let null = || Value::new_null(ctx.clone());
            let text = |value: &str| -> rquickjs::Result<Value<'js>> {
                Ok(rquickjs::String::from_str(ctx.clone(), value)?.into_value())
            };
            let src = self.to_js(&rule.content())?;
            let base_url = bindings.base_url.clone().unwrap_or_else(|| rule.base_url());
            let title = rule.chapter().map(|chapter| chapter.borrow().title.clone());
            let mut args = Args::new(ctx.clone(), 14);
            args.push_arg(globals.get::<_, Value>("java")?)?;
            args.push_arg(globals.get::<_, Value>("source")?)?;
            args.push_arg(book.clone().unwrap_or_else(null))?;
            args.push_arg(chapter.clone().unwrap_or_else(null))?;
            args.push_arg(result_value.clone())?;
            args.push_arg(src.clone())?;
            args.push_arg(text(&base_url)?)?;
            args.push_arg(match &title {
                Some(title) => text(title)?,
                None => null(),
            })?;
            args.push_arg(match rule.next_chapter_url() {
                Some(url) => text(&url)?,
                None => null(),
            })?;
            args.push_arg(match &bindings.key {
                Some(key) => text(key)?,
                None => null(),
            })?;
            args.push_arg(match bindings.page {
                Some(page) => Value::new_int(ctx.clone(), page as i32),
                None => null(),
            })?;
            args.push_arg(globals.get::<_, Value>("cookie")?)?;
            args.push_arg(globals.get::<_, Value>("cache")?)?;
            args.push_arg(text(script)?)?;
            // jsLib functions read these as globals, as Legado's shared scope
            // lets them; nested scripts restore the outer values afterwards.
            let names = ["result", "src", "baseUrl", "book", "chapter", "key", "page"];
            let saved: Vec<Value<'js>> = names
                .iter()
                .map(|name| globals.get::<_, Value>(*name).unwrap_or_else(|_| null()))
                .collect();
            globals.set("result", result_value)?;
            globals.set("src", src)?;
            globals.set("baseUrl", text(&base_url)?)?;
            globals.set("book", book.clone().unwrap_or_else(null))?;
            globals.set("chapter", chapter.clone().unwrap_or_else(null))?;
            if let Some(key) = &bindings.key {
                globals.set("key", text(key)?)?;
            }
            if let Some(page) = bindings.page {
                globals.set("page", page as i32)?;
            }
            let value = evaluate.call_arg::<Value<'js>>(args);
            for (name, previous) in names.iter().zip(saved) {
                let _ = globals.set(*name, previous);
            }
            Ok((value?, book, chapter))
        };
        let (value, book, chapter) = run().map_err(|error| self.js_error(error))?;
        if let (Some(object), Some(target)) = (book, rule.book()) {
            api::sync_book(&object, &mut target.borrow_mut());
        }
        if let (Some(object), Some(target)) = (chapter, rule.chapter()) {
            api::sync_chapter(&object, &mut target.borrow_mut());
        }
        Ok(value)
    }

    pub fn as_scripts(&self) -> &dyn UrlScripts {
        self
    }
}

impl Scripts for JsScope<'_> {
    fn eval(&self, rule: &AnalyzeRule, script: &str, result: &Val) -> SourceResult<Val> {
        self.run_script(rule, script, result, &UrlBindings::default())
    }
}

impl UrlScripts for JsScope<'_> {
    fn eval_url(
        &self,
        rule: &AnalyzeRule,
        script: &str,
        result: &Val,
        bindings: &UrlBindings,
    ) -> SourceResult<Val> {
        self.run_script(rule, script, result, bindings)
    }
}

/// Evaluates a script as a global script and returns its completion value
/// as a string, which is how Rhino gives a script without `return` a result.
pub fn eval_completion(script: &str) -> Result<String, String> {
    let runtime = Runtime::new().map_err(|error| error.to_string())?;
    let context = Context::full(&runtime).map_err(|error| error.to_string())?;
    context.with(|ctx| {
        let value: rquickjs::Value =
            eval_sloppy(&ctx, script).map_err(|error| format!("{error}"))?;
        let text: rquickjs::Coerced<String> = value.get().map_err(|error| error.to_string())?;
        Ok(text.0)
    })
}

#[cfg(test)]
mod tests;

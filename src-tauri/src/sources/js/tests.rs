use std::sync::Arc;
use std::time::{Duration, Instant};

use super::*;
use crate::sources::context::{Control, MemoryStore};
use crate::sources::error::SourceErrorKind;
use crate::sources::model::BookSource;

fn env_with(source: serde_json::Value, control: Control) -> Rc<Env> {
    let source = BookSource::from_value(source).unwrap();
    Env::new(source, Arc::new(MemoryStore::default()), control)
}

fn env() -> Rc<Env> {
    env_with(
        serde_json::json!({
            "bookSourceUrl": "https://example.com",
            "bookSourceName": "测试",
            "jsLib": "function twice(x) { return x + x } function fromJava(k) { return java.get(k) }"
        }),
        Control::unlimited(),
    )
}

fn eval(host: &JsHost, rule: &AnalyzeRule, script: &str, result: Val) -> SourceResult<Val> {
    host.run(|scope| scope.eval(rule, script, &result))
}

#[test]
fn a_script_without_return_yields_its_last_expression() {
    assert_eq!(eval_completion("var a = 1; a + 1").unwrap(), "2");
    let env = env();
    let host = JsHost::new(env.clone()).unwrap();
    let rule = AnalyzeRule::new(env);
    let value = eval(
        &host,
        &rule,
        "var r; if (result == 'a') { r = 'x' } else { r = 'y' }",
        Val::Str("a".into()),
    )
    .unwrap();
    assert_eq!(value.to_text(), "x");
    // Each script's declarations stay its own, so `let` may repeat.
    assert_eq!(
        eval(&host, &rule, "let n = 1; n", Val::Null)
            .unwrap()
            .to_text(),
        "1"
    );
    assert_eq!(
        eval(&host, &rule, "let n = 2; n", Val::Null)
            .unwrap()
            .to_text(),
        "2"
    );
}

#[test]
fn js_lib_functions_and_variables_are_shared() {
    let env = env();
    let host = JsHost::new(env.clone()).unwrap();
    let rule = AnalyzeRule::new(env);
    assert_eq!(
        eval(&host, &rule, "twice(result)", Val::Str("ab".into()))
            .unwrap()
            .to_text(),
        "abab"
    );
    eval(&host, &rule, "java.put('token', 'secret')", Val::Null).unwrap();
    assert_eq!(rule.get("token"), "secret");
    assert_eq!(
        eval(&host, &rule, "fromJava('token')", Val::Null)
            .unwrap()
            .to_text(),
        "secret"
    );
    assert_eq!(
        eval(&host, &rule, "source.getKey()", Val::Null)
            .unwrap()
            .to_text(),
        "https://example.com"
    );
    assert_eq!(
        eval(&host, &rule, "source.bookSourceName", Val::Null)
            .unwrap()
            .to_text(),
        "测试"
    );
}

#[test]
fn scripts_reach_the_rule_and_its_elements() {
    let env = env();
    let host = JsHost::new(env.clone()).unwrap();
    let rule = AnalyzeRule::new(env);
    rule.set_content(
        Val::Str(r#"<ul><li><a href="/1">一</a></li><li><a href="/2">二</a></li></ul>"#.into()),
        Some("https://example.com/b/"),
    );
    let value = eval(
        &host,
        &rule,
        "java.getString('tag.li.1@tag.a@text')",
        Val::Null,
    )
    .unwrap();
    assert_eq!(value.to_text(), "二");
    let elements = eval(&host, &rule, "java.getElements('tag.li')", Val::Null).unwrap();
    assert!(matches!(&elements, Val::Elements(list) if list.len() == 2));
    let text = eval(
        &host,
        &rule,
        "var e = java.getElements('tag.li'); e.map(x => x.select('a').attr('href')).join(',')",
        Val::Null,
    )
    .unwrap();
    assert_eq!(text.to_text(), "/1,/2");
    let parsed = eval(
        &host,
        &rule,
        "org.jsoup.Jsoup.parse('<p class=a>x</p>').select('p.a').text()",
        Val::Null,
    )
    .unwrap();
    assert_eq!(parsed.to_text(), "x");
    // A rule chain hands elements from a JS step to a default step.
    let names = host
        .run(|scope| {
            rule.get_string_list(
                scope,
                "<js>java.getElements('tag.li')</js>@tag.a@text",
                None,
                false,
            )
        })
        .unwrap()
        .unwrap();
    assert_eq!(names, vec!["一", "二"]);
    let joined = host
        .run(|scope| rule.get_string(scope, "tag.a@text@js:result.replace('\\n', '+')"))
        .unwrap();
    assert_eq!(joined, "一+二");
}

#[test]
fn json_values_cross_the_boundary_both_ways() {
    let env = env();
    let host = JsHost::new(env.clone()).unwrap();
    let rule = AnalyzeRule::new(env);
    let value = eval(
        &host,
        &rule,
        "JSON.parse(\"{a:'x', list:[1,2]}\")",
        Val::Null,
    )
    .unwrap();
    assert_eq!(value.to_text(), r#"{"a":"x","list":[1,2]}"#);
    let value = eval(
        &host,
        &rule,
        "result.data.name + JSON.parse(result).data.name",
        Val::Json(serde_json::json!({"data": {"name": "甲"}})),
    )
    .unwrap();
    assert_eq!(value.to_text(), "甲甲");
    let value = eval(&host, &rule, "[1, 'a']", Val::Null).unwrap();
    assert!(matches!(value, Val::List(items) if items.len() == 2));
}

#[test]
fn java_helpers_encode_hash_and_decrypt() {
    let env = env();
    let host = JsHost::new(env.clone()).unwrap();
    let rule = AnalyzeRule::new(env);
    let run = |script: &str| eval(&host, &rule, script, Val::Null).unwrap().to_text();
    assert_eq!(
        run("java.md5Encode('abc')"),
        "900150983cd24fb0d6963f7d28e17f72"
    );
    assert_eq!(run("java.base64Decode(java.base64Encode('正文'))"), "正文");
    assert_eq!(
        run("var c = java.createSymmetricCrypto('AES/CBC/PKCS5Padding', '0123456789abcdef', 'fedcba9876543210'); c.decryptStr(c.encryptBase64('秘密'))"),
        "秘密"
    );
    assert_eq!(run("java.aesBase64DecodeToString(java.aesEncodeToBase64String('x', '0123456789abcdef', 'AES/ECB/PKCS5Padding', ''), '0123456789abcdef', 'AES/ECB/PKCS5Padding', '')"), "x");
    assert_eq!(run("java.t2s('頭髮')"), "头发");
    assert_eq!(
        run("'abc'.equals('abc') && 'a1'.matches('[a-z]\\\\d')"),
        "true"
    );
    assert_eq!(
        run("new java.lang.String(java.strToBytes('书', 'GBK'), 'GBK')"),
        "书"
    );
    assert_eq!(
        run("with (JavaImporter(Packages.java.net)) { URLEncoder.encode('书 a', 'UTF-8') }"),
        "%E4%B9%A6+a"
    );
    assert_eq!(
        run("Packages.android.util.Base64.encodeToString(java.strToBytes('a'), 2)"),
        "YQ=="
    );
}

#[test]
fn unsupported_calls_say_so() {
    let env = env();
    let host = JsHost::new(env.clone()).unwrap();
    let rule = AnalyzeRule::new(env);
    let error = eval(&host, &rule, "java.webView('', 'https://x', '')", Val::Null).unwrap_err();
    assert_eq!(error.kind, SourceErrorKind::Unsupported);
    let error = eval(
        &host,
        &rule,
        "Packages.javax.crypto.Cipher.getInstance('x')",
        Val::Null,
    )
    .unwrap_err();
    assert_eq!(error.kind, SourceErrorKind::Script);
    assert!(
        error.message.contains("不支持: javax.crypto"),
        "{}",
        error.message
    );
    let error = eval(&host, &rule, "throw new Error('坏了')", Val::Null).unwrap_err();
    assert_eq!(error.message, "Error: 坏了");
}

#[test]
fn runaway_scripts_stop_at_the_deadline() {
    let env = env_with(
        serde_json::json!({"bookSourceUrl": "https://example.com", "bookSourceName": "测试"}),
        Control::new(
            Default::default(),
            Some(Instant::now() + Duration::from_millis(200)),
        ),
    );
    let host = JsHost::new(env.clone()).unwrap();
    let rule = AnalyzeRule::new(env);
    let started = Instant::now();
    let error = eval(&host, &rule, "while (true) {}", Val::Null).unwrap_err();
    assert_eq!(error.kind, SourceErrorKind::Timeout);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn book_fields_and_variables_round_trip() {
    let env = env();
    let host = JsHost::new(env.clone()).unwrap();
    let rule = AnalyzeRule::new(env);
    let book = Rc::new(RefCell::new(BookData {
        name: "书".into(),
        book_url: "https://example.com/b/1".into(),
        ..Default::default()
    }));
    rule.set_book(Some(book.clone()));
    let value = eval(&host, &rule, "book.putVariable('k', 'v'); book.tocUrl = book.bookUrl + '/toc'; book.name + book.getVariable('k')", Val::Null)
        .unwrap();
    assert_eq!(value.to_text(), "书v");
    assert_eq!(book.borrow().toc_url, "https://example.com/b/1/toc");
    assert_eq!(book.borrow().variables["k"], "v");
}

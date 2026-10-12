//! XPath rules, evaluated over a copy of the HTML tree, with JsoupXpath's
//! final-step functions `text()`, `allText()`, `html()`, and `outerHtml()`.

// sxd elements hash and compare by node identity, so their interior
// mutability never changes a key.
#![allow(clippy::mutable_key_type)]

use std::collections::HashMap;

use ego_tree::{NodeId, NodeRef};
use scraper::Node as HtmlNode;
use sxd_document::{dom, Package};
use sxd_xpath::nodeset::Node as XNode;
use sxd_xpath::{Context, Factory, Value as XValue};

use super::json::combine;
use super::split::{split_compound, Joiner};
use crate::sources::dom::Element;
use crate::sources::value::{format_f64, Val};

/// A result of an XPath step: an element of the page, or text.
#[derive(Debug, Clone)]
pub enum Hit {
    Element(Element),
    Text(String),
}

impl Hit {
    pub fn into_val(self) -> Val {
        match self {
            Hit::Element(element) => Val::Element(element),
            Hit::Text(text) => Val::Str(text),
        }
    }

    fn text(&self) -> String {
        match self {
            Hit::Element(element) => element.outer_html(),
            Hit::Text(text) => text.clone(),
        }
    }
}

fn valid_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    match cleaned.chars().next() {
        Some(first) if first.is_alphabetic() || first == '_' => cleaned,
        _ => format!("x{cleaned}"),
    }
}

fn copy_element<'d>(
    document: dom::Document<'d>,
    node: NodeRef<'_, HtmlNode>,
    element: &scraper::node::Element,
    ids: &mut HashMap<dom::Element<'d>, NodeId>,
) -> dom::Element<'d> {
    let copy = document.create_element(valid_name(element.name()).as_str());
    for (key, value) in element.attrs() {
        copy.set_attribute_value(valid_name(key).as_str(), value);
    }
    ids.insert(copy, node.id());
    copy_children(document, copy, node, ids);
    copy
}

fn copy_children<'d>(
    document: dom::Document<'d>,
    parent: dom::Element<'d>,
    node: NodeRef<'_, HtmlNode>,
    ids: &mut HashMap<dom::Element<'d>, NodeId>,
) {
    for child in node.children() {
        match child.value() {
            HtmlNode::Element(element) => {
                let copy = copy_element(document, child, element, ids);
                parent.append_child(copy);
            }
            HtmlNode::Text(text) => parent.append_child(document.create_text(text)),
            _ => {}
        }
    }
}

/// Strips a JsoupXpath function the standard evaluator lacks.
fn split_function(path: &str) -> (&str, Option<&'static str>) {
    for (suffix, name) in [
        ("/allText()", "allText"),
        ("/html()", "html"),
        ("/outerHtml()", "outerHtml"),
        ("/text()", "text"),
    ] {
        if let Some(stripped) = path.strip_suffix(suffix) {
            return (stripped, Some(name));
        }
    }
    (path, None)
}

/// Evaluates one XPath against the element's subtree.
pub fn evaluate(scope: &Element, path: &str) -> Result<Vec<Hit>, String> {
    let path = path.trim();
    let (base_path, function) = split_function(path);
    let package = Package::new();
    let document = package.as_document();
    let mut ids = HashMap::new();
    // An element scope becomes the document's top element, as JsoupXpath
    // treats an element it is given.
    let tops: Vec<NodeRef<'_, HtmlNode>> = if scope.is_document() {
        scope.node().children().collect()
    } else {
        vec![scope.node()]
    };
    for top in tops {
        if let HtmlNode::Element(element) = top.value() {
            let copy = copy_element(document, top, element, &mut ids);
            document.root().append_child(copy);
        }
    }
    let factory = Factory::new();
    let xpath = factory
        .build(base_path)
        .map_err(|error| format!("XPath 无效 `{path}`：{error}"))?
        .ok_or_else(|| format!("XPath 为空：{path}"))?;
    let context = Context::new();
    let value = xpath
        .evaluate(&context, document.root())
        .map_err(|error| format!("XPath 执行失败 `{path}`：{error}"))?;
    let hits: Vec<Hit> = match value {
        XValue::Nodeset(nodes) => nodes
            .document_order()
            .into_iter()
            .filter_map(|node| match node {
                XNode::Element(element) => match ids.get(&element) {
                    Some(id) => Some(Hit::Element(scope.with_id(*id))),
                    None => scope.is_document().then(|| Hit::Element(scope.clone())),
                },
                XNode::Root(_) => Some(Hit::Element(scope.clone())),
                other => Some(Hit::Text(other.string_value())),
            })
            .collect(),
        XValue::String(text) => vec![Hit::Text(text)],
        XValue::Number(number) => vec![Hit::Text(format_f64(number))],
        XValue::Boolean(flag) => vec![Hit::Text(flag.to_string())],
    };
    Ok(match function {
        None => hits,
        Some(name) => hits
            .into_iter()
            .map(|hit| match hit {
                Hit::Element(element) => Hit::Text(match name {
                    "text" => element.own_text(),
                    "allText" => element.text(),
                    "html" => element.inner_html(),
                    _ => element.outer_html(),
                }),
                text => text,
            })
            .collect(),
    })
}

/// `AnalyzeByXPath.getElements`.
pub fn get_elements(scope: &Element, rule: &str) -> Result<Vec<Hit>, String> {
    let compound = split_compound(rule, &[Joiner::And, Joiner::Or, Joiner::Interleave], false);
    let mut results = Vec::new();
    for part in &compound.parts {
        let hits = evaluate(scope, part)?;
        if !hits.is_empty() {
            results.push(hits);
            if compound.joiner == Some(Joiner::Or) {
                break;
            }
        }
    }
    Ok(combine(results, compound.joiner))
}

/// `AnalyzeByXPath.getStringList`.
pub fn get_string_list(scope: &Element, rule: &str) -> Result<Vec<String>, String> {
    Ok(get_elements(scope, rule)?.iter().map(Hit::text).collect())
}

/// `AnalyzeByXPath.getString`.
pub fn get_string(scope: &Element, rule: &str) -> Result<Option<String>, String> {
    let list = get_string_list(scope, rule)?;
    Ok((!list.is_empty()).then(|| list.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::dom::parse;

    const PAGE: &str = r#"<html><body><div id="list"><ul>
        <li><a href="/1.html">第一章</a></li><li><a href="/2.html">第二章</a></li>
      </ul></div><p class="intro">简介<b>加粗</b>尾</p></body></html>"#;

    #[test]
    fn paths_attributes_and_functions() {
        let doc = parse(PAGE, "");
        let items = get_elements(&doc, "//div[@id='list']//li").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            get_string_list(&doc, "//li/a/@href").unwrap(),
            vec!["/1.html", "/2.html"]
        );
        assert_eq!(
            get_string(&doc, "//p[@class='intro']/text()")
                .unwrap()
                .unwrap(),
            "简介尾"
        );
        assert_eq!(
            get_string(&doc, "//p/allText()").unwrap().unwrap(),
            "简介加粗尾"
        );
        assert_eq!(get_string(&doc, "count(//li)").unwrap().unwrap(), "2");
    }

    #[test]
    fn element_scopes_query_their_own_subtree() {
        let doc = parse(PAGE, "");
        let Hit::Element(item) = get_elements(&doc, "//li").unwrap().remove(1) else {
            panic!("expected an element");
        };
        assert_eq!(get_string(&item, "//a/text()").unwrap().unwrap(), "第二章");
        assert_eq!(get_string(&item, "//a/@href").unwrap().unwrap(), "/2.html");
    }
}

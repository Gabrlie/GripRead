//! EPUB books: a DRM-free, reflowable EPUB 2 or 3 becomes normalized text
//! with one paragraph per line, as a TXT does, so reading, positions,
//! search, bookmarks, transforms, and sync work unchanged. The retained
//! source is the EPUB itself, and converting it again gives the same text.
//!
//! Two kinds of private-use characters carry what plain text cannot:
//! - an image is a line holding only `U+E000 + n`, `n` indexing
//!   [`EpubBook::images`];
//! - a table-of-contents entry is `U+F0000 + n` at the start of the line it
//!   points at, `n` indexing [`EpubBook::toc`]. The directory is read back
//!   from these marks ([`toc_offsets`]), so it follows the text through
//!   replace rules and Chinese conversion.
//!
//! The reader hides both marks and draws images in their place.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use scraper::{ElementRef, Html, Node};
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::error::{AppError, ErrorCode};

pub const IMAGE_BASE: u32 = 0xE000;
const IMAGE_LIMIT: usize = 0x1900;
pub const MARK_BASE: u32 = 0xF0000;
const MARK_LIMIT: usize = 0xFFFD;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpubTocEntry {
    pub title: String,
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpubImage {
    /// The image's path inside the EPUB.
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpubBook {
    pub title: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub text: String,
    pub toc: Vec<EpubTocEntry>,
    pub images: Vec<EpubImage>,
    /// The cover image's path inside the EPUB.
    pub cover: Option<String>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidArgument, message)
}

/// Whether `bytes` are an EPUB: a ZIP whose `mimetype` says so, or one with
/// the EPUB container file when the `mimetype` entry is missing.
pub fn is_epub(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"PK\x03\x04") {
        return false;
    }
    if bytes.get(30..58) == Some(b"mimetypeapplication/epub+zip".as_slice()) {
        return true;
    }
    ZipArchive::new(Cursor::new(bytes))
        .is_ok_and(|mut archive| archive.by_name("META-INF/container.xml").is_ok())
}

/// [`is_epub`] for a file, reading only what it needs.
pub fn is_epub_file(path: &std::path::Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 58];
    let read = file.read(&mut head).unwrap_or(0);
    if !head[..read].starts_with(b"PK\x03\x04") {
        return false;
    }
    if &head[30..read.max(30)] == b"mimetypeapplication/epub+zip".as_slice() {
        return true;
    }
    std::fs::File::open(path)
        .ok()
        .and_then(|file| ZipArchive::new(file).ok())
        .is_some_and(|mut zip| zip.by_name("META-INF/container.xml").is_ok())
}

struct Archive<'a> {
    zip: ZipArchive<Cursor<&'a [u8]>>,
}

impl<'a> Archive<'a> {
    fn open(bytes: &'a [u8]) -> Result<Self, AppError> {
        ZipArchive::new(Cursor::new(bytes))
            .map(|zip| Self { zip })
            .map_err(|error| invalid(format!("EPUB 文件已损坏：{error}")))
    }

    fn read(&mut self, path: &str) -> Option<Vec<u8>> {
        let mut file = self.zip.by_name(path).ok()?;
        let mut bytes = Vec::with_capacity(file.size().min(64 << 20) as usize);
        file.read_to_end(&mut bytes).ok()?;
        Some(bytes)
    }

    fn text(&mut self, path: &str) -> Option<String> {
        let bytes = self.read(path)?;
        Some(
            String::from_utf8(bytes)
                .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned()),
        )
    }
}

/// Reads one file of the EPUB (an image or the cover).
pub fn read_file(bytes: &[u8], path: &str) -> Result<Vec<u8>, AppError> {
    Archive::open(bytes)?.read(path).ok_or_else(|| {
        AppError::keyed(
            ErrorCode::FileNotFound,
            "epubEntryMissing",
            format!("EPUB 中没有 {path}"),
        )
        .with("path", path)
    })
}

/// Reads one file of the EPUB at `path` without loading the whole book.
pub fn read_file_at(path: &std::path::Path, inner: &str) -> Result<Vec<u8>, AppError> {
    let file = std::fs::File::open(path)?;
    let mut zip =
        ZipArchive::new(file).map_err(|error| invalid(format!("EPUB 文件已损坏：{error}")))?;
    let mut entry = zip.by_name(inner).map_err(|_| {
        AppError::keyed(
            ErrorCode::FileNotFound,
            "epubEntryMissing",
            format!("EPUB 中没有 {inner}"),
        )
        .with("path", inner)
    })?;
    let mut bytes = Vec::with_capacity(entry.size().min(64 << 20) as usize);
    entry.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&text[index + 1..index + 3], 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Resolves `href` against the folder of `base` (a path inside the EPUB);
/// the fragment is returned separately.
fn resolve(base: &str, href: &str) -> (String, String) {
    let (path, fragment) = href.split_once('#').unwrap_or((href, ""));
    let path = percent_decode(path);
    let mut parts: Vec<&str> = if path.starts_with('/') {
        Vec::new()
    } else {
        base.rsplit_once('/')
            .map(|(folder, _)| folder.split('/').collect())
            .unwrap_or_default()
    };
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let resolved = if path.is_empty() {
        base.to_string()
    } else {
        parts.join("/")
    };
    (resolved, percent_decode(fragment))
}

fn local_name<'a>(node: &roxmltree::Node<'a, '_>) -> &'a str {
    node.tag_name().name()
}

fn text_of(node: roxmltree::Node) -> String {
    let text: String = node
        .descendants()
        .filter(|node| node.is_text())
        .filter_map(|node| node.text())
        .collect();
    collapse(&text)
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Refuses DRM-protected books; font obfuscation is not DRM.
fn check_drm(archive: &mut Archive) -> Result<(), AppError> {
    const FONT_OBFUSCATION: [&str; 2] = [
        "http://www.idpf.org/2008/embedding",
        "http://ns.adobe.com/pdf/enc#RC",
    ];
    if archive.read("META-INF/rights.xml").is_some() {
        return Err(invalid("这本 EPUB 有 DRM 保护，无法导入"));
    }
    let Some(xml) = archive.text("META-INF/encryption.xml") else {
        return Ok(());
    };
    let document =
        roxmltree::Document::parse(&xml).map_err(|_| invalid("这本 EPUB 有 DRM 保护，无法导入"))?;
    let protected = document
        .descendants()
        .filter(|node| local_name(node) == "EncryptionMethod")
        .filter_map(|node| node.attribute("Algorithm"))
        .any(|algorithm| !FONT_OBFUSCATION.contains(&algorithm));
    if protected {
        return Err(invalid("这本 EPUB 有 DRM 保护，无法导入"));
    }
    Ok(())
}

struct ManifestItem {
    path: String,
    media: String,
    properties: String,
}

struct Package {
    title: Option<String>,
    author: Option<String>,
    description: Option<String>,
    manifest: HashMap<String, ManifestItem>,
    spine: Vec<String>,
    /// The NCX (EPUB 2) named by the spine.
    ncx: Option<String>,
    /// The navigation document (EPUB 3).
    nav: Option<String>,
    cover: Option<String>,
}

fn read_package(archive: &mut Archive) -> Result<Package, AppError> {
    let container = archive
        .text("META-INF/container.xml")
        .ok_or_else(|| invalid("EPUB 缺少 container.xml"))?;
    let container = roxmltree::Document::parse(&container)
        .map_err(|error| invalid(format!("EPUB 的 container.xml 无效：{error}")))?;
    let opf_path = container
        .descendants()
        .find(|node| local_name(node) == "rootfile")
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| invalid("EPUB 没有指明内容文件"))?
        .to_string();
    let opf = archive
        .text(&opf_path)
        .ok_or_else(|| invalid("EPUB 缺少内容文件"))?;
    let opf = roxmltree::Document::parse(&opf)
        .map_err(|error| invalid(format!("EPUB 的内容文件无效：{error}")))?;

    let metadata = |name: &str| {
        opf.descendants()
            .find(|node| local_name(node) == name && node.tag_name().namespace().is_some())
            .map(text_of)
            .filter(|text| !text.is_empty())
    };
    let fixed = opf.descendants().any(|node| {
        local_name(&node) == "meta"
            && node.attribute("property") == Some("rendition:layout")
            && node.text().map(str::trim) == Some("pre-paginated")
    });
    if fixed {
        return Err(invalid("暂不支持固定版式的 EPUB"));
    }

    let mut manifest = HashMap::new();
    for item in opf.descendants().filter(|node| local_name(node) == "item") {
        let (Some(id), Some(href)) = (item.attribute("id"), item.attribute("href")) else {
            continue;
        };
        manifest.insert(
            id.to_string(),
            ManifestItem {
                path: resolve(&opf_path, href).0,
                media: item.attribute("media-type").unwrap_or_default().to_string(),
                properties: item.attribute("properties").unwrap_or_default().to_string(),
            },
        );
    }
    let spine_node = opf.descendants().find(|node| local_name(node) == "spine");
    let spine = spine_node
        .iter()
        .flat_map(|spine| spine.children())
        .filter(|node| local_name(node) == "itemref")
        .filter(|node| node.attribute("linear") != Some("no"))
        .filter_map(|node| node.attribute("idref"))
        .filter_map(|id| manifest.get(id).map(|item| item.path.clone()))
        .collect();
    let ncx = spine_node
        .and_then(|spine| spine.attribute("toc"))
        .and_then(|id| manifest.get(id))
        .map(|item| item.path.clone());
    let nav = manifest
        .values()
        .find(|item| {
            item.properties
                .split_whitespace()
                .any(|value| value == "nav")
        })
        .map(|item| item.path.clone());
    let cover = manifest
        .values()
        .find(|item| {
            item.properties
                .split_whitespace()
                .any(|value| value == "cover-image")
        })
        .or_else(|| {
            opf.descendants()
                .find(|node| local_name(node) == "meta" && node.attribute("name") == Some("cover"))
                .and_then(|node| node.attribute("content"))
                .and_then(|id| manifest.get(id))
        })
        .filter(|item| item.media.starts_with("image/"))
        .map(|item| item.path.clone());
    let description = metadata("description").map(|text| {
        // Descriptions are often HTML.
        collapse(
            &Html::parse_fragment(&text)
                .root_element()
                .text()
                .collect::<String>(),
        )
    });
    Ok(Package {
        title: metadata("title"),
        author: metadata("creator"),
        description: description.filter(|text| !text.is_empty()),
        manifest,
        spine,
        ncx,
        nav,
        cover,
    })
}

/// A table-of-contents entry before it is placed in the text.
struct TocTarget {
    title: String,
    depth: u32,
    path: String,
    fragment: String,
}

fn nav_toc(archive: &mut Archive, path: &str) -> Vec<TocTarget> {
    let Some(xhtml) = archive.text(path) else {
        return Vec::new();
    };
    let document = Html::parse_document(&xhtml);
    let Ok(selector) = scraper::Selector::parse("nav") else {
        return Vec::new();
    };
    let nav = document
        .select(&selector)
        .find(|nav| {
            nav.value()
                .attrs()
                .any(|(name, value)| name.ends_with("type") && value.contains("toc"))
        })
        .or_else(|| document.select(&selector).next());
    let mut entries = Vec::new();
    fn walk(list: ElementRef, depth: u32, base: &str, entries: &mut Vec<TocTarget>) {
        for item in list
            .child_elements()
            .filter(|child| child.value().name() == "li")
        {
            let link = item
                .child_elements()
                .find(|child| matches!(child.value().name(), "a" | "span"));
            if let Some(link) = link {
                let title = collapse(&link.text().collect::<String>());
                if let Some(href) = link.value().attr("href") {
                    let (path, fragment) = resolve(base, href);
                    if !title.is_empty() {
                        entries.push(TocTarget {
                            title,
                            depth,
                            path,
                            fragment,
                        });
                    }
                }
            }
            for nested in item
                .child_elements()
                .filter(|child| child.value().name() == "ol")
            {
                walk(nested, depth + 1, base, entries);
            }
        }
    }
    if let Some(nav) = nav {
        for list in nav
            .descendants()
            .filter_map(ElementRef::wrap)
            .filter(|element| element.value().name() == "ol")
            .take(1)
        {
            walk(list, 0, path, &mut entries);
        }
    }
    entries
}

fn ncx_toc(archive: &mut Archive, path: &str) -> Vec<TocTarget> {
    let Some(xml) = archive.text(path) else {
        return Vec::new();
    };
    let Ok(document) = roxmltree::Document::parse(&xml) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    fn walk(node: roxmltree::Node, depth: u32, base: &str, entries: &mut Vec<TocTarget>) {
        for point in node
            .children()
            .filter(|child| local_name(child) == "navPoint")
        {
            let title = point
                .children()
                .find(|child| local_name(child) == "navLabel")
                .map(text_of)
                .unwrap_or_default();
            let src = point
                .children()
                .find(|child| local_name(child) == "content")
                .and_then(|content| content.attribute("src"));
            if let (false, Some(src)) = (title.is_empty(), src) {
                let (path, fragment) = resolve(base, src);
                entries.push(TocTarget {
                    title,
                    depth,
                    path,
                    fragment,
                });
            }
            walk(point, depth + 1, base, entries);
        }
    }
    if let Some(map) = document
        .descendants()
        .find(|node| local_name(node) == "navMap")
    {
        walk(map, 0, path, &mut entries);
    }
    entries
}

/// Elements that start and end a line.
fn is_block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "li"
            | "blockquote"
            | "pre"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "aside"
            | "figure"
            | "figcaption"
            | "dt"
            | "dd"
            | "tr"
            | "table"
            | "ul"
            | "ol"
            | "hr"
            | "body"
    )
}

/// Builds the lines of the whole book.
struct Writer<'a> {
    lines: Vec<String>,
    line: String,
    /// `(path, id)` → the line an anchor begins.
    anchors: HashMap<(String, String), usize>,
    images: Vec<EpubImage>,
    image_index: HashMap<String, usize>,
    manifest: &'a HashMap<String, ManifestItem>,
}

impl Writer<'_> {
    fn end_line(&mut self) {
        let line = self.line.trim();
        if !line.is_empty() {
            self.lines.push(line.to_string());
        }
        self.line.clear();
    }

    /// The line that the next text will be on (the unfinished one, if any).
    fn next_line(&self) -> usize {
        self.lines.len()
    }

    fn push_text(&mut self, text: &str) {
        let mut space = self.line.ends_with(' ') || self.line.is_empty();
        for character in text.chars() {
            if character.is_whitespace() && character != '\u{3000}' {
                if !space {
                    self.line.push(' ');
                    space = true;
                }
            } else {
                self.line.push(character);
                space = false;
            }
        }
    }

    fn push_image(&mut self, archive: &mut Archive, path: String) {
        let index = match self.image_index.get(&path) {
            Some(index) => *index,
            None => {
                if self.images.len() >= IMAGE_LIMIT {
                    return;
                }
                let is_image = self
                    .manifest
                    .values()
                    .any(|item| item.path == path && item.media.starts_with("image/"));
                let Some(size) = is_image
                    .then(|| archive.read(&path))
                    .flatten()
                    .and_then(|bytes| imagesize::blob_size(&bytes).ok())
                else {
                    return;
                };
                self.images.push(EpubImage {
                    path: path.clone(),
                    width: size.width as u32,
                    height: size.height as u32,
                });
                self.image_index.insert(path, self.images.len() - 1);
                self.images.len() - 1
            }
        };
        self.end_line();
        let mark = char::from_u32(IMAGE_BASE + index as u32).unwrap_or('\u{E000}');
        self.lines.push(mark.to_string());
    }

    fn walk(&mut self, archive: &mut Archive, file: &str, element: ElementRef, pre: bool) {
        let name = element.value().name();
        if matches!(
            name,
            "script" | "style" | "head" | "rt" | "rp" | "noscript" | "title"
        ) {
            return;
        }
        if let Some(id) = element.value().id() {
            let line = self.next_line();
            self.anchors
                .entry((file.to_string(), id.to_string()))
                .or_insert(line);
        }
        let block = is_block(name);
        if block {
            self.end_line();
        }
        match name {
            "br" => self.end_line(),
            "img" => {
                if let Some(src) = element.value().attr("src") {
                    let path = resolve(file, src).0;
                    self.push_image(archive, path);
                }
            }
            "image" => {
                let href = element
                    .value()
                    .attrs()
                    .find(|(attribute, _)| *attribute == "href" || attribute.ends_with(":href"))
                    .map(|(_, value)| value);
                if let Some(href) = href {
                    let path = resolve(file, href).0;
                    self.push_image(archive, path);
                }
            }
            _ => {}
        }
        let pre = pre || name == "pre";
        for child in element.children() {
            match child.value() {
                Node::Text(text) => {
                    if pre {
                        for (index, part) in text.split('\n').enumerate() {
                            if index > 0 {
                                self.end_line();
                            }
                            self.line.push_str(part);
                        }
                    } else {
                        self.push_text(text);
                    }
                }
                Node::Element(_) => {
                    if let Some(child) = ElementRef::wrap(child) {
                        self.walk(archive, file, child, pre);
                    }
                }
                _ => {}
            }
        }
        if block {
            self.end_line();
        }
    }
}

/// Converts an EPUB to normalized text with its directory, images, and
/// metadata. DRM-protected and fixed-layout books are refused.
pub fn convert(bytes: &[u8]) -> Result<EpubBook, AppError> {
    let mut archive = Archive::open(bytes)?;
    check_drm(&mut archive)?;
    let package = read_package(&mut archive)?;
    if package.spine.is_empty() {
        return Err(invalid("EPUB 没有可阅读的内容"));
    }
    let mut writer = Writer {
        lines: Vec::new(),
        line: String::new(),
        anchors: HashMap::new(),
        images: Vec::new(),
        image_index: HashMap::new(),
        manifest: &package.manifest,
    };
    // The first line of each spine file, and the files in reading order.
    let mut starts: Vec<(String, usize)> = Vec::new();
    for path in &package.spine {
        let Some(xhtml) = archive.text(path) else {
            continue;
        };
        let start = writer.lines.len();
        let document = Html::parse_document(&xhtml);
        let root = document.root_element();
        let body = root
            .child_elements()
            .find(|child| child.value().name() == "body")
            .unwrap_or(root);
        writer.walk(&mut archive, path, body, false);
        writer.end_line();
        if writer.lines.len() > start {
            starts.push((path.clone(), start));
        }
    }
    if writer.lines.is_empty() {
        return Err(invalid("EPUB 没有可阅读的文字"));
    }

    let mut targets = match &package.nav {
        Some(nav) => nav_toc(&mut archive, nav),
        None => Vec::new(),
    };
    if targets.is_empty() {
        if let Some(ncx) = &package.ncx {
            targets = ncx_toc(&mut archive, ncx);
        }
    }
    let line_of = |target: &TocTarget| {
        (!target.fragment.is_empty())
            .then(|| {
                writer
                    .anchors
                    .get(&(target.path.clone(), target.fragment.clone()))
            })
            .flatten()
            .copied()
            .or_else(|| {
                starts
                    .iter()
                    .find(|(path, _)| *path == target.path)
                    .map(|(_, line)| *line)
            })
    };
    let mut toc = Vec::new();
    let mut marks: Vec<(usize, usize)> = Vec::new();
    for target in &targets {
        let Some(line) = line_of(target) else {
            continue;
        };
        // One entry per line, in reading order.
        if marks.iter().any(|(marked, _)| *marked == line) || toc.len() >= MARK_LIMIT {
            continue;
        }
        marks.push((line, toc.len()));
        toc.push(EpubTocEntry {
            title: target.title.clone(),
            depth: target.depth,
        });
    }
    if toc.is_empty() {
        // Without a directory, each file is a chapter named by its first line.
        for (_, line) in &starts {
            let title: String = writer.lines[*line].chars().take(40).collect();
            if title.chars().all(is_mark) {
                continue;
            }
            marks.push((*line, toc.len()));
            toc.push(EpubTocEntry { title, depth: 0 });
        }
    }
    let mut lines = writer.lines;
    for (line, index) in marks {
        if let Some(mark) = char::from_u32(MARK_BASE + index as u32) {
            lines[line].insert(0, mark);
        }
    }
    Ok(EpubBook {
        title: package.title,
        author: package.author,
        description: package.description,
        text: lines.join("\n"),
        toc,
        images: writer.images,
        cover: package.cover,
    })
}

/// Whether a character is an image or directory mark.
pub fn is_mark(character: char) -> bool {
    let code = character as u32;
    (IMAGE_BASE..IMAGE_BASE + IMAGE_LIMIT as u32).contains(&code)
        || (MARK_BASE..MARK_BASE + MARK_LIMIT as u32).contains(&code)
}

/// Removes the marks, for excerpts and read-aloud.
pub fn strip_marks(text: &str) -> String {
    text.chars()
        .filter(|character| !is_mark(*character))
        .collect()
}

/// Where each directory entry is in `text`, by its mark, as UTF-16 offsets
/// of the start of its line; `None` for an entry whose mark is gone.
pub fn toc_offsets(text: &str, entries: usize) -> Vec<Option<u64>> {
    let mut offsets = vec![None; entries];
    let mut offset = 0u64;
    let mut line_start = 0u64;
    for character in text.chars() {
        let code = character as u32;
        if character == '\n' {
            line_start = offset + 1;
        } else if (MARK_BASE..MARK_BASE + MARK_LIMIT as u32).contains(&code) {
            let index = (code - MARK_BASE) as usize;
            if let Some(slot) = offsets.get_mut(index) {
                slot.get_or_insert(line_start);
            }
        }
        offset += character.len_utf16() as u64;
    }
    offsets
}

/// The directory of an EPUB's (possibly transformed) text, from its marks.
pub fn build_toc(
    text: &str,
    book_id: &str,
    content_version: &str,
    toc: &[EpubTocEntry],
) -> crate::txt_toc::TocBuild {
    let mut found: Vec<(u64, &EpubTocEntry)> = toc_offsets(text, toc.len())
        .into_iter()
        .zip(toc)
        .filter_map(|(offset, entry)| offset.map(|offset| (offset, entry)))
        .collect();
    found.sort_by_key(|(offset, _)| *offset);
    // UTF-16 offsets to byte offsets, for the locators' context.
    let mut bytes = Vec::with_capacity(found.len());
    let (mut units, mut next) = (0u64, found.iter().map(|(offset, _)| *offset).peekable());
    for (byte, character) in text.char_indices() {
        while next.peek().is_some_and(|offset| *offset <= units) {
            bytes.push(byte);
            next.next();
        }
        units += character.len_utf16() as u64;
    }
    bytes.resize(found.len(), text.len());
    let total = units;
    let entries = found
        .iter()
        .enumerate()
        .map(|(index, (offset, entry))| {
            let end = found.get(index + 1).map_or(total, |(next, _)| *next);
            crate::models::TocEntry {
                ordinal: index as u64,
                title: entry.title.clone(),
                volume: false,
                length: end - offset,
                locator: crate::m1_txt::make_toc_locator(
                    text,
                    book_id,
                    content_version,
                    bytes[index],
                    *offset,
                ),
                tag: None,
            }
        })
        .collect();
    crate::txt_toc::TocBuild {
        entries,
        rule_id: None,
        rule_name: "EPUB 目录".to_string(),
        intro: None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Builds an EPUB from `(path, contents)`, with the mimetype first.
    pub(crate) fn build(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut out);
        let stored =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        for (path, contents) in files {
            zip.start_file(*path, SimpleFileOptions::default()).unwrap();
            zip.write_all(contents).unwrap();
        }
        zip.finish().unwrap();
        out.into_inner()
    }

    const CONTAINER: &str = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;

    /// A 2×1 PNG.
    pub(crate) const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
        0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0xf4, 0x78, 0xd4, 0xfa, 0, 0, 0, 0, 0x49, 0x45, 0x4e,
        0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    pub(crate) fn epub3() -> Vec<u8> {
        let opf = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title><dc:creator>作者甲</dc:creator>
    <dc:description>&lt;p&gt;一本&lt;b&gt;测试&lt;/b&gt;书。&lt;/p&gt;</dc:description>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/p%201.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"#;
        let nav = r#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
  <li><a href="text/c1.xhtml">第一章 开始</a>
    <ol><li><a href="text/c1.xhtml#s2">第一节</a></li></ol></li>
  <li><a href="text/c2.xhtml">第二章 结束</a></li>
</ol></nav></body></html>"#;
        let c1 = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title><style>p{}</style></head><body>
<h1>第一章 开始</h1>
<p>  第一段，  有
   换行。</p>
<p><img src="../images/p%201.png" alt=""/></p>
<p id="s2">第二段<br/>同段换行<ruby>字<rt>zi</rt></ruby></p>
<script>alert(1)</script>
</body></html>"#;
        let c2 = r#"<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div><h2>第二章 结束</h2><p>最后。</p></div></body></html>"#;
        build(&[
            ("META-INF/container.xml", CONTAINER.as_bytes()),
            ("OEBPS/content.opf", opf.as_bytes()),
            ("OEBPS/nav.xhtml", nav.as_bytes()),
            ("OEBPS/text/c1.xhtml", c1.as_bytes()),
            ("OEBPS/text/c2.xhtml", c2.as_bytes()),
            ("OEBPS/images/p 1.png", PNG),
        ])
    }

    fn mark(index: u32) -> char {
        char::from_u32(MARK_BASE + index).unwrap()
    }

    #[test]
    fn an_epub3_becomes_lines_with_marks_images_and_metadata() {
        let bytes = epub3();
        assert!(is_epub(&bytes));
        assert!(!is_epub(b"plain text"));
        let book = convert(&bytes).unwrap();
        assert_eq!(book.title.as_deref(), Some("测试之书"));
        assert_eq!(book.author.as_deref(), Some("作者甲"));
        assert_eq!(book.description.as_deref(), Some("一本测试书。"));
        assert_eq!(book.cover.as_deref(), Some("OEBPS/images/p 1.png"));
        assert_eq!(
            book.images,
            vec![EpubImage {
                path: "OEBPS/images/p 1.png".into(),
                width: 2,
                height: 1
            }]
        );
        let expected = format!(
            "{}第一章 开始\n第一段， 有 换行。\n\u{E000}\n{}第二段\n同段换行字\n{}第二章 结束\n最后。",
            mark(0),
            mark(1),
            mark(2)
        );
        assert_eq!(book.text, expected);
        assert_eq!(
            book.toc
                .iter()
                .map(|entry| (entry.title.as_str(), entry.depth))
                .collect::<Vec<_>>(),
            vec![("第一章 开始", 0), ("第一节", 1), ("第二章 结束", 0)]
        );
        let offsets = toc_offsets(&book.text, 3);
        let line_start = |needle: &str| {
            let at = book.text.find(needle).unwrap();
            let start = book.text[..at].rfind('\n').map_or(0, |index| index + 1);
            book.text[..start].encode_utf16().count() as u64
        };
        assert_eq!(
            offsets,
            vec![
                Some(0),
                Some(line_start("第二段")),
                Some(line_start("第二章"))
            ]
        );
        assert_eq!(strip_marks(&book.text).lines().next(), Some("第一章 开始"));
        let directory = build_toc(&book.text, "b", "v", &book.toc);
        assert_eq!(
            directory
                .entries
                .iter()
                .map(|entry| (entry.title.as_str(), entry.locator.offset))
                .collect::<Vec<_>>(),
            vec![
                ("第一章 开始", 0),
                ("第一节", line_start("第二段")),
                ("第二章 结束", line_start("第二章"))
            ]
        );
        assert_eq!(
            directory.entries[2].length,
            book.text.encode_utf16().count() as u64 - line_start("第二章")
        );
        assert!(directory.entries[1]
            .locator
            .context_after
            .contains("第二段"));
        assert_eq!(read_file(&bytes, "OEBPS/images/p 1.png").unwrap(), PNG);
        // Converting again gives the same text.
        assert_eq!(convert(&bytes).unwrap().text, book.text);
    }

    #[test]
    fn an_epub2_uses_its_ncx_and_files_without_a_directory_get_their_first_line() {
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>二</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="a" href="a.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="a"/></spine></package>"#;
        let ncx = r#"<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint id="n1"><navLabel><text>甲章</text></navLabel><content src="a.html#x"/></navPoint>
</navMap></ncx>"#;
        let a = r#"<html><body><p>序</p><h2 id="x">甲章</h2><p>正文</p></body></html>"#;
        let with_ncx = build(&[
            ("META-INF/container.xml", CONTAINER.as_bytes()),
            ("OEBPS/content.opf", opf.as_bytes()),
            ("OEBPS/toc.ncx", ncx.as_bytes()),
            ("OEBPS/a.html", a.as_bytes()),
        ]);
        let book = convert(&with_ncx).unwrap();
        assert_eq!(book.text, format!("序\n{}甲章\n正文", mark(0)));

        let bare = build(&[
            ("META-INF/container.xml", CONTAINER.as_bytes()),
            ("OEBPS/content.opf", opf.as_bytes()),
            ("OEBPS/a.html", a.as_bytes()),
        ]);
        let book = convert(&bare).unwrap();
        assert_eq!(book.toc[0].title, "序");
        assert!(book.text.starts_with(mark(0)));
    }

    #[test]
    fn drm_and_fixed_layout_books_are_refused() {
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf"><metadata/>
<manifest><item id="a" href="a.html" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="a"/></spine></package>"#;
        let encryption = r#"<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
  xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData>
  <enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
</enc:EncryptedData></encryption>"#;
        let locked = build(&[
            ("META-INF/container.xml", CONTAINER.as_bytes()),
            ("META-INF/encryption.xml", encryption.as_bytes()),
            ("OEBPS/content.opf", opf.as_bytes()),
            ("OEBPS/a.html", b"<p>x</p>".as_slice()),
        ]);
        assert!(convert(&locked).unwrap_err().message.contains("DRM"));
        let fonts = encryption
            .replace(
                "http://www.w3.org/2001/04/xmlenc#aes128-cbc",
                "http://www.idpf.org/2008/embedding",
            )
            .into_bytes();
        let obfuscated = build(&[
            ("META-INF/container.xml", CONTAINER.as_bytes()),
            ("META-INF/encryption.xml", &fonts),
            ("OEBPS/content.opf", opf.as_bytes()),
            ("OEBPS/a.html", b"<p>x</p>".as_slice()),
        ]);
        assert!(convert(&obfuscated).is_ok());
        let fixed = opf
            .replace(
                "<metadata/>",
                r#"<metadata><meta property="rendition:layout">pre-paginated</meta></metadata>"#,
            )
            .into_bytes();
        let fixed = build(&[
            ("META-INF/container.xml", CONTAINER.as_bytes()),
            ("OEBPS/content.opf", &fixed),
            ("OEBPS/a.html", b"<p>x</p>".as_slice()),
        ]);
        assert!(convert(&fixed).unwrap_err().message.contains("固定版式"));
    }

    #[test]
    fn relative_paths_resolve_inside_the_book() {
        assert_eq!(
            resolve("OEBPS/text/c1.xhtml", "../images/a%20b.png#f"),
            ("OEBPS/images/a b.png".into(), "f".into())
        );
        assert_eq!(
            resolve("OEBPS/text/c1.xhtml", "#n"),
            ("OEBPS/text/c1.xhtml".into(), "n".into())
        );
        assert_eq!(
            resolve("content.opf", "a.html"),
            ("a.html".into(), "".into())
        );
    }
}

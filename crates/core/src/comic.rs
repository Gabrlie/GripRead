//! Comics: a chapter is a list of page images. An online comic's chapter
//! text (from an image source) holds one `<img src>` line per page; its
//! pages are fetched through the source one at a time when read or cached,
//! and kept with the chapter. A local comic is text as an EPUB is, one image
//! mark line per page, and its pages are read from the retained archive.

use std::fs;

use crate::error::{AppError, ErrorCode};
use crate::models::{ComicChapter, ComicPage};
use crate::online_reader::Shared;

fn lock(storage: &Shared) -> Result<std::sync::MutexGuard<'_, crate::storage::Storage>, AppError> {
    storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
}

fn no_pages() -> AppError {
    AppError::keyed(ErrorCode::NotFound, "comicNoPages", "这一话没有图片")
}

/// The page addresses of an online chapter's text, in order.
pub fn page_urls(raw: &str) -> Vec<String> {
    raw.lines()
        .filter_map(crate::sources::web_book::image_of_line)
        .map(str::to_string)
        .collect()
}

/// An image file's size from its header, when it is one.
fn image_size(path: &std::path::Path) -> Option<(u32, u32)> {
    imagesize::size(path)
        .ok()
        .map(|size| (size.width as u32, size.height as u32))
}

/// An online comic chapter's pages, fetching its text when not kept.
pub fn online_chapter(
    storage: &Shared,
    book_id: &str,
    index: u32,
) -> Result<ComicChapter, AppError> {
    crate::online_reader::ensure_toc(storage, book_id)?;
    let raw = crate::online_reader::raw_chapter(storage, book_id, index)?;
    let urls = page_urls(&raw);
    if urls.is_empty() {
        return Err(no_pages());
    }
    let guard = lock(storage)?;
    let chapter = guard
        .online_chapter(book_id, index)?
        .ok_or_else(|| AppError::keyed(ErrorCode::NotFound, "chapterMissing", "没有这一章"))?;
    let titles = guard.title_transform(book_id)?;
    let pages = (0..urls.len() as u32)
        .map(|page| {
            let (width, height) =
                image_size(&guard.comic_page_path(book_id, &chapter, page)).unwrap_or((0, 0));
            ComicPage {
                width,
                height,
                offset: u64::from(page),
            }
        })
        .collect();
    Ok(ComicChapter {
        index,
        title: titles.title(&chapter.title),
        resource_id: crate::storage::chapter_resource(index),
        content_version: crate::storage::chapter_version(book_id, &chapter),
        pages,
    })
}

/// One page of an online comic chapter: kept, or fetched through the
/// source (its headers, cookies, and `imageDecode`) and kept.
pub fn online_page(
    storage: &Shared,
    book_id: &str,
    index: u32,
    page: u32,
) -> Result<Vec<u8>, AppError> {
    let (chapter, path, source_url) = {
        let guard = lock(storage)?;
        let chapter = guard
            .online_chapter(book_id, index)?
            .ok_or_else(|| AppError::keyed(ErrorCode::NotFound, "chapterMissing", "没有这一章"))?;
        let path = guard.comic_page_path(book_id, &chapter, page);
        let source_url = guard.online_record(book_id)?.book.source_url;
        (chapter, path, source_url)
    };
    if let Ok(bytes) = fs::read(&path) {
        return Ok(bytes);
    }
    let raw = crate::online_reader::raw_chapter(storage, book_id, chapter.index)?;
    let url = page_urls(&raw)
        .into_iter()
        .nth(page as usize)
        .ok_or_else(no_pages)?;
    let bytes = crate::online_commands::content_image_bytes(storage, &source_url, &url)?;
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    // Written whole, then moved in, so a page is never half kept.
    let partial = path.with_extension("part");
    fs::write(&partial, &bytes)?;
    fs::rename(&partial, &path)?;
    Ok(bytes)
}

/// Caches an online comic chapter: its text, then every page not kept.
/// Pages that fail are left for reading to try again; the count says how
/// many did.
pub fn cache_online_chapter(
    storage: &Shared,
    book_id: &str,
    index: u32,
) -> Result<usize, AppError> {
    let chapter = online_chapter(storage, book_id, index)?;
    let mut failed = 0;
    for page in 0..chapter.pages.len() as u32 {
        if online_page(storage, book_id, index, page).is_err() {
            failed += 1;
        }
    }
    Ok(failed)
}

// Local comics.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::sync::{Arc, Mutex, OnceLock};

use crate::epub::{EpubBook, EpubImage, EpubTocEntry, MARK_BASE};

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"];

fn is_image_name(name: &str) -> bool {
    let file = name.rsplit('/').next().unwrap_or(name);
    !file.starts_with('.')
        && !name.starts_with("__MACOSX/")
        && file.rsplit_once('.').is_some_and(|(_, extension)| {
            IMAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

/// Natural order: `2.jpg` before `10.jpg`, case not counting.
pub fn natural_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    fn parts(text: &str) -> Vec<(bool, String)> {
        let mut parts: Vec<(bool, String)> = Vec::new();
        for character in text.chars() {
            let digit = character.is_ascii_digit();
            match parts.last_mut() {
                Some((was, part)) if *was == digit => part.push(character),
                _ => parts.push((digit, character.to_string())),
            }
        }
        parts
    }
    let (left, right) = (parts(&left.to_lowercase()), parts(&right.to_lowercase()));
    for ((left_digit, left), (right_digit, right)) in left.iter().zip(&right) {
        let order = if *left_digit && *right_digit {
            let (a, b) = (left.trim_start_matches('0'), right.trim_start_matches('0'));
            a.len().cmp(&b.len()).then_with(|| a.cmp(b))
        } else {
            left.cmp(right)
        };
        if order != std::cmp::Ordering::Equal {
            return order;
        }
    }
    left.len().cmp(&right.len())
}

/// The extension a book file is named with in the cloud: by its content.
pub fn book_extension(path: &std::path::Path) -> &'static str {
    if crate::epub::is_epub_file(path) {
        return "epub";
    }
    let archive = std::fs::File::open(path)
        .ok()
        .and_then(|file| zip::ZipArchive::new(file).ok());
    if archive.is_some_and(|archive| archive.file_names().any(is_image_name)) {
        "cbz"
    } else {
        "txt"
    }
}

/// Whether `bytes` are a comic archive: a ZIP (CBZ) of images that is not an EPUB.
pub fn is_comic_archive(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"PK\x03\x04") || crate::epub::is_epub(bytes) {
        return false;
    }
    zip::ZipArchive::new(Cursor::new(bytes))
        .is_ok_and(|archive| archive.file_names().any(is_image_name))
}

/// The text of one tag in ComicInfo.xml.
fn comic_info(xml: &str, tag: &str) -> Option<String> {
    let document = roxmltree::Document::parse(xml).ok()?;
    document
        .descendants()
        .find(|node| node.tag_name().name() == tag)
        .and_then(|node| node.text())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// A comic archive as a book's text: per folder (a chapter, in natural
/// order; a flat archive is one chapter named `title`), its title line
/// with the chapter mark, then one image mark line per page.
pub fn convert_archive(bytes: &[u8], title: &str) -> Result<EpubBook, AppError> {
    let invalid = |message: String| AppError::new(ErrorCode::InvalidArgument, message);
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| invalid(format!("压缩包已损坏：{error}")))?;
    let mut info = None;
    if let Ok(mut file) = archive.by_name("ComicInfo.xml") {
        let mut xml = String::new();
        if file.read_to_string(&mut xml).is_ok() {
            info = Some(xml);
        }
    }
    let names: Vec<String> = archive
        .file_names()
        .filter(|name| is_image_name(name))
        .map(str::to_string)
        .collect();
    if names.is_empty() {
        return Err(AppError::keyed(
            ErrorCode::InvalidArgument,
            "comicNoImages",
            "压缩包里没有图片",
        ));
    }
    let folder = |name: &str| {
        name.rsplit_once('/')
            .map_or(String::new(), |(folder, _)| folder.to_string())
    };
    let mut folders: HashMap<String, Vec<String>> = HashMap::new();
    for name in names {
        folders.entry(folder(&name)).or_default().push(name);
    }
    let mut chapters: Vec<(String, Vec<String>)> = folders.into_iter().collect();
    chapters.sort_by(|(left, _), (right, _)| natural_cmp(left, right));
    let mut text = String::new();
    let mut toc = Vec::new();
    let mut images = Vec::new();
    for (folder, mut pages) in chapters {
        pages.sort_by(|left, right| natural_cmp(left, right));
        let name = folder.rsplit('/').next().unwrap_or_default().trim();
        let chapter = if name.is_empty() {
            title.to_string()
        } else {
            name.to_string()
        };
        let Some(mark) = char::from_u32(MARK_BASE + toc.len() as u32) else {
            break;
        };
        text.push(mark);
        text.push_str(&chapter);
        text.push('\n');
        toc.push(EpubTocEntry {
            title: chapter,
            depth: 0,
        });
        for page in pages {
            let Some(image) = crate::epub::image_mark(images.len()) else {
                break;
            };
            let Ok(mut file) = archive.by_name(&page) else {
                continue;
            };
            let mut bytes = Vec::with_capacity(file.size().min(64 << 20) as usize);
            if file.read_to_end(&mut bytes).is_err() {
                continue;
            }
            // A file that is not an image (a broken page) is left out.
            let Ok(size) = imagesize::blob_size(&bytes) else {
                continue;
            };
            images.push(EpubImage {
                path: page,
                width: size.width as u32,
                height: size.height as u32,
            });
            text.push(image);
            text.push('\n');
        }
    }
    if images.is_empty() {
        return Err(AppError::keyed(
            ErrorCode::InvalidArgument,
            "comicNoImages",
            "压缩包里没有图片",
        ));
    }
    let info = info.as_deref();
    Ok(EpubBook {
        title: info.and_then(|xml| comic_info(xml, "Series").or_else(|| comic_info(xml, "Title"))),
        author: info.and_then(|xml| comic_info(xml, "Writer")),
        description: info.and_then(|xml| comic_info(xml, "Summary")),
        cover: images.first().map(|image| image.path.clone()),
        text,
        toc,
        images,
        comic: true,
    })
}

/// A local comic's pages by chapter: each page's text offset and image.
struct Layout {
    content_version: String,
    resource_id: String,
    titles: Vec<String>,
    chapters: Vec<Vec<(u64, usize)>>,
    images: Vec<EpubImage>,
    source: std::path::PathBuf,
}

fn layouts() -> &'static Mutex<HashMap<String, Arc<Layout>>> {
    static LAYOUTS: OnceLock<Mutex<HashMap<String, Arc<Layout>>>> = OnceLock::new();
    LAYOUTS.get_or_init(Default::default)
}

fn layout(storage: &Shared, book_id: &str) -> Result<Arc<Layout>, AppError> {
    let guard = lock(storage)?;
    let current = guard.book_asset(book_id)?;
    if let Some(found) = layouts()
        .lock()
        .ok()
        .and_then(|layouts| layouts.get(&current.id).cloned())
        .filter(|found| found.content_version == current.content_version)
    {
        return Ok(found);
    }
    let (text, asset, toc, images, source) = guard.comic_text(book_id)?;
    let key = asset.id.clone();
    let titles = guard.title_transform(book_id)?;
    drop(guard);
    let mut starts: Vec<(u64, usize)> = crate::epub::toc_offsets(&text, toc.len())
        .into_iter()
        .enumerate()
        .filter_map(|(index, offset)| offset.map(|offset| (offset, index)))
        .collect();
    starts.sort();
    let mut chapters = vec![Vec::new(); starts.len()];
    let mut offset = 0u64;
    for line in text.split('\n') {
        let chapter = starts
            .partition_point(|(start, _)| *start <= offset)
            .saturating_sub(1);
        if let Some(image) = line.chars().find_map(crate::epub::image_of_mark) {
            if let Some(pages) = chapters.get_mut(chapter) {
                pages.push((offset, image));
            }
        }
        offset += line.encode_utf16().count() as u64 + 1;
    }
    let found = Arc::new(Layout {
        content_version: asset.content_version.clone(),
        resource_id: asset.id.clone(),
        titles: starts
            .iter()
            .map(|(_, index)| titles.title(&toc[*index].title))
            .collect(),
        chapters,
        images,
        source,
    });
    if let Ok(mut layouts) = layouts().lock() {
        layouts.insert(key, Arc::clone(&found));
    }
    Ok(found)
}

pub fn local_chapter(
    storage: &Shared,
    book_id: &str,
    index: u32,
) -> Result<ComicChapter, AppError> {
    let layout = layout(storage, book_id)?;
    let pages = layout.chapters.get(index as usize).ok_or_else(no_pages)?;
    if pages.is_empty() {
        return Err(no_pages());
    }
    Ok(ComicChapter {
        index,
        title: layout.titles[index as usize].clone(),
        resource_id: layout.resource_id.clone(),
        content_version: layout.content_version.clone(),
        pages: pages
            .iter()
            .map(|(offset, image)| {
                let image = &layout.images[*image];
                ComicPage {
                    width: image.width,
                    height: image.height,
                    offset: *offset,
                }
            })
            .collect(),
    })
}

pub fn local_page(
    storage: &Shared,
    book_id: &str,
    chapter: u32,
    page: u32,
) -> Result<Vec<u8>, AppError> {
    let layout = layout(storage, book_id)?;
    let (_, image) = layout
        .chapters
        .get(chapter as usize)
        .and_then(|pages| pages.get(page as usize))
        .ok_or_else(no_pages)?;
    crate::epub::read_file_at(&layout.source, &layout.images[*image].path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{OnlineBook, OnlineChapter};
    use crate::sources::test_server::{start, Request, Response};
    use crate::storage::Storage;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A PNG header saying `width` × `height` pixels.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend([0, 0, 0, 13]);
        png.extend(b"IHDR");
        png.extend(width.to_be_bytes());
        png.extend(height.to_be_bytes());
        png.extend([8, 6, 0, 0, 0]);
        png
    }

    struct Dir(std::path::PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn dir() -> Dir {
        let dir =
            Dir(std::env::temp_dir().join(format!("gripread-comic-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(&dir.0).unwrap();
        dir
    }

    #[test]
    fn natural_order_counts_numbers() {
        let mut names = vec!["p10.jpg", "p2.jpg", "P1.jpg", "p02a.jpg"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["P1.jpg", "p2.jpg", "p02a.jpg", "p10.jpg"]);
    }

    #[test]
    fn online_pages_are_fetched_one_at_a_time_and_kept() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&hits);
        let base = start(move |request: &Request| match request.path.as_str() {
            "/c/1.html" => Response::html(
                r#"<div id="content"><img data-src="/p/1.png"><img src="/p/2.png"></div>"#,
            ),
            "/p/1.png" | "/p/2.png" => {
                counted.fetch_add(1, Ordering::SeqCst);
                Response::bytes("image/png", png(4, 6))
            }
            _ => Response::not_found(),
        });
        let root = dir();
        let mut storage = Storage::open(&root.0).unwrap();
        storage
            .save_book_source(
                &serde_json::json!({
                    "bookSourceUrl": base,
                    "bookSourceName": "漫画站",
                    "bookSourceType": 2,
                    "ruleContent": {"content": "id.content@html"}
                })
                .to_string(),
                None,
            )
            .unwrap();
        let book = OnlineBook {
            source_url: base.clone(),
            source_name: "漫画站".into(),
            name: "海贼".into(),
            author: "尾田".into(),
            kind: String::new(),
            cover_url: String::new(),
            intro: String::new(),
            word_count: String::new(),
            latest_chapter_title: String::new(),
            book_url: format!("{base}/book/1/"),
            toc_url: format!("{base}/book/1/"),
            variables: String::new(),
            reverse_toc: false,
            comic: true,
        };
        let chapters = vec![OnlineChapter {
            index: 0,
            title: "第1话".into(),
            url: "/c/1.html".into(),
            base_url: format!("{base}/book/1/"),
            is_volume: false,
            is_vip: false,
            is_pay: false,
            tag: String::new(),
            variables: String::new(),
        }];
        let id = storage.add_online_book(&book, &chapters, true).unwrap();
        let storage: Shared = Arc::new(Mutex::new(storage));
        let chapter = online_chapter(&storage, &id, 0).unwrap();
        assert_eq!(chapter.title, "第1话");
        assert_eq!(chapter.resource_id, "chapter-0");
        // Sizes are unknown until a page is kept; nothing is fetched yet.
        assert_eq!(chapter.pages.len(), 2);
        assert_eq!((chapter.pages[1].width, chapter.pages[1].offset), (0, 1));
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        assert_eq!(online_page(&storage, &id, 0, 1).unwrap(), png(4, 6));
        assert_eq!(online_page(&storage, &id, 0, 1).unwrap(), png(4, 6));
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "a kept page is read from the device"
        );
        let again = online_chapter(&storage, &id, 0).unwrap();
        assert_eq!((again.pages[1].width, again.pages[1].height), (4, 6));
        // Caching fetches the rest.
        assert_eq!(cache_online_chapter(&storage, &id, 0).unwrap(), 0);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        assert!(
            storage
                .lock()
                .unwrap()
                .online_record(&id)
                .unwrap()
                .book
                .comic
        );
    }

    fn cbz(files: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn a_comic_archive_imports_with_chapters_in_natural_order() {
        let bytes = cbz(&[
            ("第10话/2.png", png(1, 2)),
            ("第2话/10.png", png(3, 4)),
            ("第2话/9.png", png(5, 6)),
            ("第10话/1.png", png(7, 8)),
            ("__MACOSX/第2话/._9.png", vec![0]),
            ("第2话/notes.txt", b"x".to_vec()),
            (
                "ComicInfo.xml",
                "<ComicInfo><Series>海贼</Series><Writer>尾田</Writer></ComicInfo>"
                    .as_bytes()
                    .to_vec(),
            ),
        ]);
        assert!(is_comic_archive(&bytes));
        let book = convert_archive(&bytes, "file").unwrap();
        assert_eq!(
            (book.title.as_deref(), book.author.as_deref()),
            (Some("海贼"), Some("尾田"))
        );
        let titles: Vec<_> = book.toc.iter().map(|entry| entry.title.as_str()).collect();
        assert_eq!(titles, ["第2话", "第10话"]);
        let pages: Vec<_> = book
            .images
            .iter()
            .map(|image| image.path.as_str())
            .collect();
        assert_eq!(
            pages,
            [
                "第2话/9.png",
                "第2话/10.png",
                "第10话/1.png",
                "第10话/2.png"
            ]
        );
        assert_eq!(book.cover.as_deref(), Some("第2话/9.png"));

        // Imported, its pages read back by chapter.
        let root = dir();
        let source = root.0.join("海贼.cbz");
        std::fs::write(&source, &bytes).unwrap();
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let imported = storage
            .import_txt(&source, "comic", &Default::default(), |_, _, _| {})
            .unwrap();
        assert_eq!(imported.asset.kind, crate::models::AssetKind::Comic);
        assert_eq!(imported.book.title, "海贼");
        let id = imported.book.id.clone();
        let storage: Shared = Arc::new(Mutex::new(storage));
        let second = local_chapter(&storage, &id, 1).unwrap();
        assert_eq!(second.title, "第10话");
        assert_eq!(
            second
                .pages
                .iter()
                .map(|page| (page.width, page.height))
                .collect::<Vec<_>>(),
            [(7, 8), (1, 2)]
        );
        assert_eq!(local_page(&storage, &id, 1, 1).unwrap(), png(1, 2));
        // A page's offset is a place positions can be saved at.
        let locator = crate::models::ReaderLocator {
            book_id: id.clone(),
            content_version: second.content_version.clone(),
            resource_id: second.resource_id.clone(),
            offset: second.pages[1].offset,
            context_before: String::new(),
            context_after: String::new(),
        };
        storage.lock().unwrap().save_position(&locator).unwrap();
        let toc = {
            let guard = storage.lock().unwrap();
            let (rule, _) = guard.toc_rule_snapshot(&id).unwrap();
            let context = guard.content_read_context(&id).unwrap();
            let verified = crate::storage::verify_content_context(&context).unwrap();
            crate::storage::build_toc_from_context(&context, &verified, &id, &rule).unwrap()
        };
        assert_eq!(
            toc.entries
                .iter()
                .map(|entry| entry.title.as_str())
                .collect::<Vec<_>>(),
            ["第2话", "第10话"]
        );
        assert!(local_chapter(&storage, &id, 2).is_err());
    }

    #[test]
    fn many_pages_get_marks_past_the_first_range() {
        assert_eq!(crate::epub::image_mark(0), Some('\u{E000}'));
        let late = crate::epub::image_mark(7000).unwrap();
        assert_eq!(crate::epub::image_of_mark(late), Some(7000));
        assert!(crate::epub::is_mark(late));
    }
}

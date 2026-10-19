# Comics

Status: implemented

## Scope

Read comics from Legado image sources (`bookSourceType` 2) and from local files: CBZ and ZIP archives of images and fixed-layout EPUBs whose pages are pictures; a folder import picks up the archives in it. Folders of loose images, CBR (RAR) archives, audio sources, and file sources are not read.

## Interfaces

A comic chapter is a list of pages. `get_comic_chapter` returns a chapter's pages, each with its size when known and its locator offset; `read_comic_page` returns one page's bytes. Both answer for online and local comics (`crates/core/src/comic.rs`). The frontend's `ComicPages` (`src/application/comic.ts`) keeps a session's chapters and page images and maps places to locators. A comic is read in the same reader as a book (`ReaderView`): `useComicSession` reads its contents, place, and chapters, and `ComicSurface` lays the pages out in place of the text, under the reader's own menus, panels, and dialogs.

**Online comics:** an image source's book carries `comic` on its `OnlineBook`, set from the source's type when found, and synced with the book. The chapter text is the source's content with one `<img>` line per page (as for [chapter images](sources.md)); a page is fetched through the source (its headers, cookies, Referer retry, and `imageDecode`) when shown, preloaded, or cached, and kept under `online/<book>/comic/<chapter file>/<page>`. A page's offset is its number, in the chapter's resource. Caching a chapter fetches every page; clearing the cache removes them with the chapters.

**Local comics:** the archive is imported as the `comic` asset kind and held like an EPUB: text with a directory mark and title line per chapter (each folder, in natural order; a flat archive is one chapter named after the file) and one image mark line per page, with page paths and sizes beside it and the archive retained. `ComicInfo.xml` gives the title, author, and introduction. Marks past the first 6400 pages use `U+100000 + n`. A page's offset is its image line, so positions, bookmarks, progress sync, and backups work as for text books. A fixed-layout EPUB imports as a comic when it has pictures and no more than about 20 characters of text per picture; other fixed-layout EPUBs are still refused.

## Behavior

The reader opens at once, showing its menus and a spinner while the contents and the saved place are read together, then that chapter; a failure to open offers retry and back. It saves the page shown. The reading page is the reader's: the top bar (bookmark, 更新目录, 换源, 缓存, the book's details, and 漫画设置 in More; the text tools are left out), the bottom bar (上一话 and 下一话, the page slider, and the chosen tools a comic offers: contents, 界面, night, bookmark, settings), the brightness bar, the 界面 preset's colours and night mode, and the contents with bookmarks. **Modes:** 条漫 is one vertical strip in which the next chapter joins as its predecessor's end comes near and the previous one loads on request; 单页 shows one page; 双页 shows two side by side on a wide screen held sideways, one otherwise. Single and double pages turn left to right or right to left, by tap zones, swipes, arrow keys, and volume keys, and sit in the middle of the screen; a page fitted to the width scrolls from its top when taller than the screen. The strip is the screen's width up to 760 CSS px. Taps go through the comic's own nine tap zones (by default the left column and top band go back, the right column and bottom band on, and the middle shows the menu), read mirrored left to right while turning right to left; in the strip, back and on scroll by most of a screen. Pinch or double tap zooms around the middle of the view and a drag pans while zoomed. A touch the browser takes over for scrolling (`pointercancel`) is never a tap; the strip's own reports of the page read never scroll it, nothing scrolls it while a finger is down, and a page that grows above the view moves the view by as much (native scroll anchoring is off, so every WebView behaves alike).

**Loading:** pages near the screen load, with the known size reserved (3:4 until a page's size is known); a fixed number of pages ahead are preloaded, and the next chapter's start when the end is near. Pages download three at a time, nearest the page read first; waiting pages more than twelve from it are dropped when the reader moves away, and asked for again when near. In the core, chapter pictures have download slots of their own, apart from covers. At most 40 page images stay decoded; those on screen are kept, and the oldest others released. A failed page shows a retry, a failed chapter a message and retry; offline, a note says uncached pages cannot load.

**Settings (`ReaderPreferences.comic`, synced with the reading preferences):** the reader's 界面 panel shows them for a comic in place of the text settings: mode, direction, fit (width, height, or the whole page), strip gap, pages preloaded (1–20, default 5), background (theme, black, or white), the page number, and, with the theme background, the 界面 presets. Its 更多设置 is the reader's (screen on, system bars, volume keys, menu colours, orientation) with the comic's own tap zones (`tapZones`, nine actions).

**Elsewhere:** search can be limited to text or comic sources, and results keep a comic and a novel of the same name apart; changing a comic's source searches only comic sources. Comics are marked in search results, on the shelf, on the detail page, and in source management, which can filter by kind. Converting to a local book, translation, and text tools do not apply to comics; the core refuses converting one.

## Acceptance

- An image source's chapter lists its pages without fetching them; a page is fetched once and then read from the device; caching fetches the rest.
- A CBZ with folders imports with chapters and pages in natural order and ComicInfo metadata; a page offset saves as a position; a fixed-layout EPUB of pictures imports as a comic.
- The reader opens at the saved page, turns across chapters both ways and in both directions, retries a failed page and a failed chapter, and saves a changed setting.
- A comic reads under the reader's menus and theme without text tools; its tap zones turn, mirrored right to left; a single page is centred; a cancelled touch does not turn; the page read is asked for first, at most three at a time.

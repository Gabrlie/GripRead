# Book translation

Status: implemented

## Scope

A book in another language can be read translated into the reader's language, as the translation alone (仅译文) or with each paragraph followed by its translation (双语对照). Translation runs on the device through a large language model (OpenAI-compatible services, Claude, Gemini), DeepL, or DeepLX. The server does not translate.

## Interfaces

**Settings:**
- **Device-local:** engines with their addresses, models, keys, prompts, and extra request headers (`{apiKey}` and `{model}` are filled in the address and headers; when either takes the key, the kind's key header is not sent), kept in a device-local file that is never in backups or sync records.
- **Also device-local:** the target language, the display, the default engine, 提前翻译 (chapters of online books translated ahead, two by default), and 自动翻译外语书籍. Each book's language and its translation are stored with the book on the device (`book_translation`, schema 23).

**Cache:** translations are cached by source line, target, and engine (kind, model, prompt), and are cleared in 数据管理.

**Local books:** the transform reads translations from a fixed snapshot rather than the growing cache, so the managed text stays reproducible; see [translation snapshots](../notes/implemented/2026-10-15-translation-snapshots.md). The job reports progress as `book-translation` events and is stopped through the operation `translate:<book id>`.

## Behavior

**Detection and what is translated:**
- A book's language is detected from a sample of its text and can be corrected per book.
- A book already in the target language is not translated.
- Paragraphs are translated in batches that keep their count.
- Marks for images and contents entries, and empty lines, pass through.
- A failed or partial answer leaves the original lines, and is retried later.

**Online and local books:**
- Online chapters are translated as they open, along with the next chapters ahead; while a chapter being opened is translated, the reader shows 正在翻译 with the paragraphs done (`chapter-translation` events; those translated ahead are marked and not shown).
- 搜索 and 发现 lists have 翻译, which translates the titles shown (and those loaded later) with the default engine, each row showing the translation over the original, until 显示原文; a book's detail page has 翻译简介 for its introduction. Texts already in the target language are left as written (`translate_texts`, through the shared cache).
- A translated line starts with the mark U+100000, kept in the text like the image and directory marks so offsets hold; the reader hides it and styles those paragraphs with 译文样式 (默认, 弱化, 引用, 斜体, 模糊 until a tap shows it, or 自定义 CSS declarations with a live preview; selectors and at-rules are dropped). Local translations stored before the mark read without it until translated again.
- A translation is one paragraph: line breaks in an answer become spaces, and an empty answer leaves the line untranslated and uncached.
- 测试 in an engine's settings reports success with the sample's translation and the time taken, or failure with the reason.
- Local books are translated from the reader's place onward (about 3,000 lines) in a background job, which resumes when the book opens. Translated ranges take effect in steps, and position and bookmarks relocate as they do for 简繁转换. 翻译整本 runs the job to the end, and it can be stopped. While it runs, the reader shows 翻译中 with a percentage.
- A book that kept no original file cannot be translated, and says so.

## Acceptance

- Each engine kind translates against a stub server, keeping the line count.
- A local book's translated text is reproducible from its snapshot, and its position and bookmarks keep their place across steps.
- Online chapters are translated and cached, and switching the display re-renders without new requests.
- Keys never appear in backups, sync records, or logs.

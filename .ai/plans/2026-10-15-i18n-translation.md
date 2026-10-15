# 0.2.2: Interface languages and book translation

Status: in-progress

## Outcome

Release 0.2.2 with two capabilities:
- **Interface languages:** the interface can be shown in 简体中文 (the default) or English ([i18n](../subsystems/i18n.md)).
- **Book translation:** a book in another language can be read translated, either as the translation alone or bilingually, through a large language model or DeepL ([Translation](../subsystems/translation.md)).

Before them, publishing moved onto the tag's branch and pre-release pages list only new changes ([workflow](../engineering/workflow.md#versions-and-releases)).

## Scope

**Included:**
- the interface dictionary and language setting;
- extracting the frontend's Chinese text;
- translation keys for errors that reach the interface;
- translation engines (OpenAI-compatible, Claude, Gemini, DeepL);
- language detection, a translation cache, and translating online chapters and local books;
- the reader's translation dialog and the 翻译 settings page.

**Excluded:**
- interface languages beyond the two;
- translating log lines;
- translating on the server;
- spoken translation.

## Interfaces

**Batches:**
1. the i18n foundation, then the extraction by area;
2. engines, settings, cache, detection, and online chapters;
3. local books and the reader.

Engines and keys stay in a device-local file. The target language and display sync with the reading preferences. Local books keep a deterministic transform by reading translations from per-book snapshots.

## Acceptance criteria

- **Interface:** switching to English changes every screen without a restart; a missing English string fails the typecheck.
- **Online books:** an online chapter is translated as it is opened, and the next chapters ahead.
- **Local books:** a local English book is translated from the current chapter onward, position and bookmarks keep their place, and re-importing the same file still matches.
- **Engines:** each engine kind translates against a stub server; a failed or partial answer leaves the original lines.

## Verification

Commands and results are recorded here per batch.

**Interface languages:**
- `pnpm check` passed with 246 frontend, 228 core, and 13 server tests.
- Each extraction batch was committed after typecheck and tests.
- A rebuild of the English source area after a faulty deduplication script was checked by the typecheck and the one-area test.

**Translation, online books (C1):**
- `pnpm check` passed with 249 frontend, 232 core, and 13 server tests.
- Each engine kind (OpenAI-compatible, Claude, Gemini, DeepL) translated against an in-process stub.
- Detection was checked on English, simplified and traditional Chinese, and Japanese samples.
- Local books follow in C2.

## Handoff

Pending.

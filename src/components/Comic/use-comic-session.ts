import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppRuntime } from "../../application/runtime";
import {
  ComicPages,
  chapterOf,
  comicChapters,
  coreIndex,
  pageLocator,
  pageOf,
  type ComicPlace,
} from "../../application/comic";
import type { ComicChapter, ReaderLocator, TocEntry } from "../../types/generated";
import { t } from "../../i18n";
import { describeError } from "../Cloud/format";
import { toast } from "../ui/toast";

export interface ComicSession {
  pages: ComicPages | null;
  /** The contents as listed, volumes included; `null` until read. */
  toc: TocEntry[] | null;
  /** The chapters moved through: the contents without volume lines. */
  chapters: TocEntry[];
  place: ComicPlace | null;
  /** The chapter of the place, once its pages are known. */
  current: ComicChapter | undefined;
  loaded: Record<number, ComicChapter>;
  failures: Record<number, string>;
  /** Why the comic could not be opened. */
  opening: string | null;
  setPlace: (place: ComicPlace) => void;
  loadChapter: (chapter: number) => Promise<ComicChapter>;
  /** Goes to a place, loading its chapter first; `"last"` is its last page. */
  go: (chapter: number, page: number | "last") => void;
  seek: (locator: ReaderLocator) => void;
  /** Turns `step` pages, into the neighbouring chapter at an edge. */
  turn: (direction: "next" | "previous", step: number) => void;
  /** The place as a locator, to save, bookmark, or compare. */
  locator: () => ReaderLocator | null;
  /** Reads the comic again (a retry, or after 更新目录 or 换源), at `at` when given. */
  reload: (at?: ReaderLocator | null) => void;
}

/**
 * A comic's reading session inside the reader: the contents and the saved
 * place are read together, then the place's chapter; the place is saved as
 * the page's locator, so progress, bookmarks, and sync work as for books.
 * `bookId` is `null` for a book that is not a comic, and nothing is read.
 */
export function useComicSession(
  bookId: string | null,
  runtime: AppRuntime,
  /** Pages fetched ahead of the place. */
  preload: number,
): ComicSession {
  const [revision, setRevision] = useState(0);
  const pages = useMemo(
    () => (bookId ? new ComicPages(runtime.services.library, bookId) : null),
    [runtime, bookId, revision],
  );
  useEffect(() => () => pages?.dispose(), [pages]);
  const [toc, setToc] = useState<TocEntry[] | null>(null);
  const chapters = useMemo(() => comicChapters(toc ?? []), [toc]);
  const [opening, setOpening] = useState<string | null>(null);
  const [place, setPlace] = useState<ComicPlace | null>(null);
  const [loaded, setLoaded] = useState<Record<number, ComicChapter>>({});
  const [failures, setFailures] = useState<Record<number, string>>({});
  /** Where to open after a reload, instead of the saved place. */
  const target = useRef<ReaderLocator | null>(null);
  // Another book starts without the last one's contents.
  useEffect(() => setToc(null), [bookId]);

  const loadChapter = useCallback(
    (chapter: number): Promise<ComicChapter> => {
      if (!pages) return Promise.reject(new Error("closed"));
      return pages.chapter(coreIndex(chapters, chapter)).then(
        (found) => {
          setLoaded((current) => ({ ...current, [chapter]: found }));
          setFailures((current) => {
            const { [chapter]: _gone, ...rest } = current;
            return rest;
          });
          return found;
        },
        (failure: unknown) => {
          setFailures((current) => ({ ...current, [chapter]: describeError(failure) }));
          throw failure;
        },
      );
    },
    [pages, chapters],
  );

  // Opening: the contents and the saved place together, then that chapter.
  useEffect(() => {
    if (!bookId || !pages) return;
    let active = true;
    setOpening(null);
    setPlace(null);
    setLoaded({});
    setFailures({});
    void (async () => {
      try {
        const wanted = target.current;
        target.current = null;
        const [listing, saved] = await Promise.all([
          runtime.services.reader.listToc(bookId),
          wanted ? Promise.resolve(wanted) : runtime.positions.load(bookId).catch(() => null),
        ]);
        if (!active) return;
        const entries = comicChapters(listing.entries);
        if (!entries.length) throw new Error(t("comic.noChapters"));
        setToc(listing.entries);
        const chapter = saved ? chapterOf(entries, saved) : 0;
        const found = await pages.chapter(coreIndex(entries, chapter));
        if (!active) return;
        setLoaded({ [chapter]: found });
        setPlace({ chapter, page: saved ? pageOf(found, saved) : 0 });
      } catch (failure) {
        if (active) setOpening(describeError(failure));
      }
    })();
    return () => {
      active = false;
    };
  }, [bookId, pages, runtime]);

  const current = place ? loaded[place.chapter] : undefined;

  // The place goes into the saved position, and leads the page downloads.
  useEffect(() => {
    if (!bookId || !place || !current) return;
    runtime.positions.queue(pageLocator(bookId, current, place.page));
    pages?.focus(current.index, place.page);
  }, [bookId, place, current, runtime, pages]);

  // Pages ahead are fetched before they are reached, after the one shown
  // (the queue serves the nearest first); near a chapter's end, the next
  // chapter's pages are listed too.
  useEffect(() => {
    if (!place || !current || !pages) return;
    const ahead = Array.from({ length: preload }, (_, step) => place.page + 1 + step);
    pages.preload(
      current.index,
      ahead.filter((page) => page < current.pages.length),
    );
    if (place.page + preload >= current.pages.length && place.chapter + 1 < chapters.length)
      void loadChapter(place.chapter + 1).catch(() => undefined);
  }, [place, current, preload, pages, chapters.length, loadChapter]);

  const go = useCallback(
    (chapter: number, page: number | "last") => {
      if (chapter < 0 || chapter >= chapters.length) {
        toast({ text: chapter < 0 ? t("comic.atStart") : t("comic.atEnd") });
        return;
      }
      void loadChapter(chapter).then(
        (found) =>
          setPlace({
            chapter,
            page: page === "last" ? found.pages.length - 1 : Math.min(page, found.pages.length - 1),
          }),
        () => setPlace({ chapter, page: 0 }),
      );
    },
    [chapters.length, loadChapter],
  );

  const seek = useCallback(
    (locator: ReaderLocator) => {
      const chapter = chapterOf(chapters, locator);
      void loadChapter(chapter).then(
        (found) => setPlace({ chapter, page: pageOf(found, locator) }),
        () => setPlace({ chapter, page: 0 }),
      );
    },
    [chapters, loadChapter],
  );

  const turn = useCallback(
    (direction: "next" | "previous", step: number) => {
      if (!place) return;
      const count = loaded[place.chapter]?.pages.length ?? 0;
      if (direction === "next") {
        if (place.page + step < count) setPlace({ ...place, page: place.page + step });
        else go(place.chapter + 1, 0);
      } else if (place.page - step >= 0) setPlace({ ...place, page: place.page - step });
      else if (place.page > 0) setPlace({ ...place, page: 0 });
      else go(place.chapter - 1, "last");
    },
    [place, loaded, go],
  );

  const locator = useCallback(
    () => (bookId && place && current ? pageLocator(bookId, current, place.page) : null),
    [bookId, place, current],
  );

  const reload = useCallback((at?: ReaderLocator | null) => {
    target.current = at ?? null;
    setRevision((value) => value + 1);
  }, []);

  return {
    pages,
    toc,
    chapters,
    place,
    current,
    loaded,
    failures,
    opening,
    setPlace,
    loadChapter,
    go,
    seek,
    turn,
    locator,
    reload,
  };
}

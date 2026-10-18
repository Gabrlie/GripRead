import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { useRuntime, useSettings } from "../../application/runtime";
import {
  ComicPages,
  DEFAULT_COMIC,
  chapterOf,
  comicChapters,
  coreIndex,
  pageLocator,
  pageOf,
  type ComicPlace,
} from "../../application/comic";
import { keepOnlineCover, updateOnlineToc } from "../../application/online";
import type {
  Bookmark,
  ComicChapter,
  ComicPreferences,
  ProgressPrompt,
  ReaderLocator,
  TocEntry,
} from "../../types/generated";
import { t } from "../../i18n";
import { system } from "../../services/system";
import { describeError } from "../Cloud/format";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { ContentsPage } from "../Reader/pages/ContentsPage";
import { CloudProgressDialog } from "../Reader/dialogs/CloudProgressDialog";
import { useReadingTime } from "../Reader/use-reading-time";
import { ComicSettingsSheet } from "./ComicSettingsSheet";
import { useZoom } from "./use-zoom";

const BACKGROUNDS: Record<ComicPreferences["background"], string> = {
  theme: "bg-surface",
  black: "bg-black",
  white: "bg-white",
};

/** Whether two pages fit side by side. */
function wide() {
  return window.innerWidth >= 700 && window.innerWidth > window.innerHeight;
}

/** One page: its box sized before the image arrives, then the image, or a retry. */
function ComicPageView({
  pages,
  chapter,
  index,
  page,
  fit,
  near,
}: {
  pages: ComicPages;
  chapter: ComicChapter;
  index: number;
  page: number;
  fit: ComicPreferences["fit"];
  /** Close enough to the screen to load. */
  near: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState(() => {
    const known = chapter.pages[page];
    return known && known.width > 0 ? { width: known.width, height: known.height } : null;
  });
  useEffect(() => {
    if (!near) return;
    let active = true;
    setFailed(null);
    pages.page(index, page).then(
      (found) => active && setUrl(found),
      (failure: unknown) => active && setFailed(describeError(failure)),
    );
    return () => {
      active = false;
    };
  }, [pages, index, page, near, attempt]);
  const ratio = size ? `${size.width} / ${size.height}` : "3 / 4";
  const sizing =
    fit === "width"
      ? "w-full"
      : fit === "height"
        ? "h-full w-auto max-w-none"
        : "max-h-full max-w-full";
  return (
    <div
      data-comic-page={`${chapter.index}:${page}`}
      className={`relative flex items-center justify-center mx-auto ${fit === "width" ? "w-full" : "h-full"}`}
      style={fit === "width" ? { aspectRatio: ratio } : undefined}
    >
      {url && !failed ? (
        <img
          src={url}
          alt={t("comic.pageAlt", { page: page + 1 })}
          draggable={false}
          className={`block select-none ${sizing}`}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (!size && image.naturalWidth)
              setSize({ width: image.naturalWidth, height: image.naturalHeight });
          }}
          onError={() => setFailed(t("comic.pageBroken"))}
        />
      ) : failed ? (
        <button
          type="button"
          data-comic-control
          className="flex flex-col items-center gap-1 text-xs text-secondary px-4 py-6"
          onClick={() => setAttempt((value) => value + 1)}
        >
          <Icon name="refresh" size={20} />
          {t("comic.pageFailed")}
          <span className="text-[11px] opacity-80 line-clamp-2">{failed}</span>
        </button>
      ) : (
        <span className="text-xs text-secondary">{page + 1}</span>
      )}
    </div>
  );
}

/**
 * The comic reader: a strip of pages chapter after chapter (条漫), or one
 * page (or two, on a wide screen) at a time, left to right or right to
 * left. Pinch or double tap zooms; the middle of the screen shows the menu.
 * The place is saved as the page's locator, so progress, bookmarks, and sync
 * work as for books.
 */
export function ComicReader() {
  const { activeBook, closeReader, takeReaderPage } = useApp();
  const runtime = useRuntime();
  const { state: settings, store: settingsStore } = useSettings();
  const book = activeBook!;
  const bookId = book.book.id;
  const online = Boolean(book.online);
  const preferences: ComicPreferences = { ...DEFAULT_COMIC, ...settings.value?.comic };
  const style = settings.value?.style;
  const pages = useMemo(() => new ComicPages(runtime.services.library, bookId), [runtime, bookId]);
  useEffect(() => () => pages.dispose(), [pages]);

  const [toc, setToc] = useState<TocEntry[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const chapters = useMemo(() => comicChapters(toc ?? []), [toc]);
  const [place, setPlace] = useState<ComicPlace | null>(null);
  const [loaded, setLoaded] = useState<Record<number, ComicChapter>>({});
  const [failures, setFailures] = useState<Record<number, string>>({});
  const [controls, setControls] = useState(false);
  const [panel, setPanel] = useState<"contents" | "settings" | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [cloud, setCloud] = useState<ProgressPrompt | null>(null);
  const [askShelf, setAskShelf] = useState(false);
  const [offline, setOffline] = useState(() => navigator.onLine === false);
  const progressSyncOn = useRef(false);

  useReadingTime(bookId, runtime.services.library, false);

  const loadChapter = useCallback(
    (chapter: number): Promise<ComicChapter> =>
      pages.chapter(coreIndex(chapters, chapter)).then(
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
      ),
    [pages, chapters],
  );

  // Opening: the contents, the saved place, and that chapter's pages.
  useEffect(() => {
    let active = true;
    setOpening(null);
    void (async () => {
      try {
        const listing = await runtime.services.reader.listToc(bookId);
        if (!active) return;
        const entries = comicChapters(listing.entries);
        if (!entries.length) throw new Error(t("comic.noChapters"));
        setToc(listing.entries);
        const saved = await runtime.positions.load(bookId).catch(() => null);
        const chapter = saved ? chapterOf(entries, saved) : 0;
        const found = await pages.chapter(coreIndex(entries, chapter));
        if (!active) return;
        setLoaded({ [chapter]: found });
        setPlace({ chapter, page: saved ? pageOf(found, saved) : 0 });
        if (takeReaderPage() === "contents") setPanel("contents");
      } catch (failure) {
        if (active) setOpening(describeError(failure));
      }
    })();
    return () => {
      active = false;
    };
    // takeReaderPage is read once per opening.
  }, [bookId, pages, runtime, revision]);

  useEffect(() => {
    void runtime.services.reader.listBookmarks(bookId).then(setBookmarks, () => undefined);
  }, [bookId, runtime]);

  // The place goes into the saved position.
  const current = place ? loaded[place.chapter] : undefined;
  useEffect(() => {
    if (!place || !current) return;
    runtime.positions.queue(pageLocator(bookId, current, place.page));
  }, [bookId, place, current, runtime]);

  // Pages ahead are fetched before they are reached.
  useEffect(() => {
    if (!place || !current) return;
    const ahead = Array.from({ length: preferences.preload }, (_, step) => place.page + 1 + step);
    pages.preload(
      coreIndex(chapters, place.chapter),
      ahead.filter((page) => page < current.pages.length),
    );
    // The next chapter's start, when this one is nearly done.
    if (
      place.page + preferences.preload >= current.pages.length &&
      place.chapter + 1 < chapters.length
    )
      void loadChapter(place.chapter + 1).catch(() => undefined);
  }, [place, current, preferences.preload, pages, chapters, loadChapter]);

  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Legado keeps the screen on while reading.
  const keepScreenOn = style?.keepScreenOn ?? true;
  useEffect(() => {
    if (!keepScreenOn) return;
    system.setKeepScreenOn(true);
    return () => system.setKeepScreenOn(false);
  }, [keepScreenOn]);

  // 同步阅读进度: another device's place is offered on opening.
  useEffect(() => {
    let cancelled = false;
    const sync = runtime.services.sync;
    void Promise.all([sync.getWebDav(), sync.getServer().catch(() => null)]).then(
      ([webdav, server]) => {
        if (cancelled) return;
        progressSyncOn.current =
          (server?.connected ?? false) || (webdav.configured && webdav.syncProgress);
        if (!progressSyncOn.current) return;
        void runtime.progressSync.fetch(bookId).then(
          (prompt) => !cancelled && prompt && setCloud(prompt),
          () => undefined,
        );
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [bookId, runtime]);

  /** Goes to a place, loading its chapter first; a page past the end means the last. */
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

  const doubled = preferences.mode === "double" && wide();
  const step = doubled ? 2 : 1;
  const turn = useCallback(
    (direction: "next" | "previous") => {
      if (!place) return;
      const count = loaded[place.chapter]?.pages.length ?? 0;
      if (direction === "next") {
        if (place.page + step < count) setPlace({ ...place, page: place.page + step });
        else go(place.chapter + 1, 0);
      } else if (place.page - step >= 0) setPlace({ ...place, page: place.page - step });
      else if (place.page > 0) setPlace({ ...place, page: 0 });
      else go(place.chapter - 1, "last");
    },
    [place, loaded, step, go],
  );

  const close = useCallback(
    (toDetail = false) => {
      if (book.online && !book.online.onShelf && !askShelf) {
        setAskShelf(true);
        return;
      }
      closeReader(toDetail);
      const chapterTitle = current?.title ?? "";
      void runtime.positions
        .flush()
        .then(() => {
          if (progressSyncOn.current)
            void runtime.progressSync.upload(bookId, chapterTitle).catch(() => undefined);
          return runtime.library.refresh();
        })
        .catch(() => undefined);
    },
    [book, askShelf, closeReader, current, runtime, bookId],
  );

  // Escape (and Android back) closes the topmost layer, then the reader.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]'))
          return;
        event.preventDefault();
        if (panel) setPanel(null);
        else if (controls) setControls(false);
        else close();
      } else if (preferences.mode !== "scroll" && !panel) {
        const rtl = preferences.direction === "right_to_left";
        if (event.key === "ArrowRight") turn(rtl ? "previous" : "next");
        else if (event.key === "ArrowLeft") turn(rtl ? "next" : "previous");
        else if (event.key === "PageDown" || event.key === " ") turn("next");
        else if (event.key === "PageUp") turn("previous");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [panel, controls, close, preferences.mode, preferences.direction, turn]);

  // Volume keys turn pages (Legado 音量键翻页) while the menu is closed.
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const volumeTurns = (style?.volumeKeys ?? true) && !controls && panel === null;
  const stripTurn = useRef<((direction: "next" | "previous") => void) | null>(null);
  useEffect(() => {
    if (!volumeTurns) return;
    system.setVolumeKeys(true);
    const unsubscribe = system.onVolumeKey((direction) =>
      preferences.mode === "scroll" ? stripTurn.current?.(direction) : turnRef.current(direction),
    );
    return () => {
      unsubscribe();
      system.setVolumeKeys(false);
    };
  }, [volumeTurns, preferences.mode]);

  const saveComic = (change: Partial<ComicPreferences>) =>
    settingsStore.set({ comic: { ...preferences, ...change } });

  const addBookmark = () => {
    if (!place || !current) return;
    void runtime.services.reader
      .addBookmark({
        bookId,
        locator: pageLocator(bookId, current, place.page),
        excerpt: t("comic.bookmarkExcerpt", { chapter: current.title, page: place.page + 1 }),
      })
      .then(
        (added) => {
          setBookmarks((list) => [added, ...list]);
          toast({ text: t("reader.bookmarkAdded") });
        },
        (failure: unknown) => toast({ text: describeError(failure), error: true }),
      );
  };

  const updateToc = () => {
    void updateOnlineToc(runtime.services.sources, [bookId]).then(
      () => {
        pages.dispose();
        setLoaded({});
        setRevision((value) => value + 1);
        toast({ text: t("comic.tocUpdated") });
      },
      (failure: unknown) => toast({ text: describeError(failure), error: true }),
    );
  };

  const background = BACKGROUNDS[preferences.background];
  const count = current?.pages.length ?? 0;
  const status = (
    <>
      {offline && (
        <p className="pointer-events-none fixed top-[calc(env(safe-area-inset-top)+0.5rem)] inset-x-0 z-[46] text-center text-[11px] text-secondary">
          {t("comic.offline")}
        </p>
      )}
    </>
  );

  if (opening || !place) {
    return (
      <div
        className={`fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 p-6 text-center ${background}`}
      >
        {opening ? (
          <>
            <p className="text-sm text-error max-w-sm">
              {t("comic.openFailed", { error: opening })}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => close()}>
                {t("common.back")}
              </Button>
              <Button size="sm" onClick={() => setRevision((value) => value + 1)}>
                {t("common.retry")}
              </Button>
            </div>
          </>
        ) : (
          <p role="status" className="text-sm text-secondary">
            {t("comic.opening")}
          </p>
        )}
        {status}
      </div>
    );
  }

  return (
    <div className={`fixed inset-0 z-40 overflow-hidden ${background}`} data-testid="comic-reader">
      {preferences.mode === "scroll" ? (
        <ComicStrip
          pages={pages}
          chapters={chapters}
          loaded={loaded}
          failures={failures}
          place={place}
          preferences={preferences}
          onPlace={setPlace}
          onLoad={(chapter) => void loadChapter(chapter).catch(() => undefined)}
          onMenu={() => setControls((value) => !value)}
          turnRef={stripTurn}
        />
      ) : (
        <ComicPaged
          pages={pages}
          chapters={chapters}
          chapter={current}
          failure={failures[place.chapter]}
          place={place}
          doubled={doubled}
          preferences={preferences}
          onTurn={turn}
          onRetry={() => void loadChapter(place.chapter).catch(() => undefined)}
          onMenu={() => setControls((value) => !value)}
        />
      )}
      {status}
      {preferences.pageNumber && count > 0 && !controls && (
        <span className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+0.4rem)] right-3 z-[45] rounded-full bg-black/45 px-2 py-0.5 text-[11px] text-white">
          {t("comic.page", { page: place.page + 1, count })}
        </span>
      )}
      {controls && (
        <>
          <header className="fixed top-0 inset-x-0 z-[47] bg-surface/95 backdrop-blur pt-safe shadow-sm">
            <div className="flex items-center gap-1 h-12 px-1">
              <button
                type="button"
                aria-label={t("common.back")}
                className="h-10 w-10 shrink-0 flex items-center justify-center rounded-full"
                onClick={() => close()}
              >
                <Icon name="arrow_back" size={20} />
              </button>
              <div className="flex-1 min-w-0">
                <h1 className="truncate text-sm font-semibold">{book.book.title}</h1>
                <p className="truncate text-[11px] text-secondary">{current?.title ?? ""}</p>
              </div>
              <button
                type="button"
                aria-label={t("reader.addBookmark")}
                className="h-10 w-10 shrink-0 flex items-center justify-center rounded-full"
                onClick={addBookmark}
              >
                <Icon name="bookmark_add" size={20} />
              </button>
            </div>
          </header>
          <footer className="fixed bottom-0 inset-x-0 z-[47] bg-surface/95 backdrop-blur pb-safe shadow-[0_-1px_4px_rgba(0,0,0,0.08)]">
            <div className="flex items-center gap-2 px-3 pt-2">
              <button
                type="button"
                className="shrink-0 text-xs text-secondary px-1 disabled:opacity-40"
                disabled={place.chapter === 0}
                onClick={() => go(place.chapter - 1, 0)}
              >
                {t("comic.previousChapter")}
              </button>
              <input
                type="range"
                aria-label={t("comic.pageSlider")}
                className="flex-1 min-w-0 accent-[var(--color-primary)]"
                min={1}
                max={Math.max(1, count)}
                value={place.page + 1}
                onChange={(event) => setPlace({ ...place, page: Number(event.target.value) - 1 })}
              />
              <button
                type="button"
                className="shrink-0 text-xs text-secondary px-1 disabled:opacity-40"
                disabled={place.chapter + 1 >= chapters.length}
                onClick={() => go(place.chapter + 1, 0)}
              >
                {t("comic.nextChapter")}
              </button>
            </div>
            <div className="grid grid-cols-2 h-12">
              <button
                type="button"
                className="flex flex-col items-center justify-center gap-0.5 text-[11px]"
                onClick={() => setPanel("contents")}
              >
                <Icon name="list" size={19} />
                {t("detail.contents")}
              </button>
              <button
                type="button"
                className="flex flex-col items-center justify-center gap-0.5 text-[11px]"
                onClick={() => setPanel("settings")}
              >
                <Icon name="tune" size={19} />
                {t("comic.settings")}
              </button>
            </div>
          </footer>
        </>
      )}
      {panel === "contents" && toc && (
        <ContentsPage
          bookTitle={book.book.title}
          toc={toc}
          ruleName=""
          splitLongChapters={false}
          position={current?.pages[place.page]?.offset ?? 0}
          resourceId={current?.resourceId}
          loading={false}
          error={null}
          busy={false}
          bookmarks={bookmarks}
          contentVersion={current?.contentVersion}
          kind={online ? "online" : "epub"}
          comic
          onReload={() => setRevision((value) => value + 1)}
          onSeek={(locator) => {
            setPanel(null);
            setControls(false);
            seek(locator);
          }}
          onOpenBookmark={(bookmark) => {
            setPanel(null);
            setControls(false);
            seek(bookmark.locator);
          }}
          onDeleteBookmark={(bookmark) =>
            void runtime.services.reader
              .deleteBookmark({ bookmarkId: bookmark.id })
              .then(() => setBookmarks((list) => list.filter((item) => item.id !== bookmark.id)))
          }
          onEditBookmark={() => undefined}
          onOpenRules={() => undefined}
          onToggleSplit={() => undefined}
          onUpdateToc={online ? updateToc : undefined}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "settings" && (
        <ComicSettingsSheet
          preferences={preferences}
          keepScreenOn={keepScreenOn}
          volumeKeys={style?.volumeKeys ?? true}
          onChange={saveComic}
          onKeepScreenOn={(on) =>
            style && settingsStore.set({ style: { ...style, keepScreenOn: on } })
          }
          onVolumeKeys={(on) => style && settingsStore.set({ style: { ...style, volumeKeys: on } })}
          onClose={() => setPanel(null)}
        />
      )}
      {cloud && toc && (
        <CloudProgressDialog
          prompt={{ ...cloud, excerpt: "" }}
          toc={chapters}
          here={current ? pageLocator(bookId, current, place.page) : null}
          onAnswer={(jump) => {
            const prompt = cloud;
            setCloud(null);
            void runtime.progressSync.acknowledge(prompt, bookId).catch(() => undefined);
            if (jump) seek(prompt.locator);
          }}
        />
      )}
      {askShelf && (
        <Dialog open onOpenChange={(open) => !open && setAskShelf(false)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("reader.addToShelf")}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm">{t("reader.askAdd", { title: book.book.title })}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => closeAfterShelf(false)}>
                {t("reader.dontAdd")}
              </Button>
              <Button size="sm" onClick={() => closeAfterShelf(true)}>
                {t("reader.addToShelf")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );

  function closeAfterShelf(add: boolean) {
    const leave = () => {
      closeReader(false);
      void runtime.positions
        .flush()
        .then(() => runtime.library.refresh())
        .catch(() => undefined);
    };
    if (!add) return leave();
    void runtime.services.sources.setOnShelf(bookId, true).then(
      () => {
        void keepOnlineCover(runtime.services.sources, book);
        leave();
      },
      (failure: unknown) => toast({ text: describeError(failure), error: true }),
    );
  }
}

/** A chapter that could not be read, with a retry. */
function ChapterFailure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 px-6 text-center">
      <p className="text-sm text-error">{t("comic.chapterFailed", { error })}</p>
      <Button size="sm" variant="outline" data-comic-control onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}

/**
 * 条漫: chapters one after another in a vertical strip. The next chapter
 * joins when its predecessor's end comes near; the previous one is a tap
 * at the top. The page a third of the way down the screen is the place.
 */
function ComicStrip({
  pages,
  chapters,
  loaded,
  failures,
  place,
  preferences,
  onPlace,
  onLoad,
  onMenu,
  turnRef,
}: {
  pages: ComicPages;
  chapters: readonly TocEntry[];
  loaded: Record<number, ComicChapter>;
  failures: Record<number, string>;
  place: ComicPlace;
  preferences: ComicPreferences;
  onPlace: (place: ComicPlace) => void;
  onLoad: (chapter: number) => void;
  onMenu: () => void;
  turnRef: React.MutableRefObject<((direction: "next" | "previous") => void) | null>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [first, setFirst] = useState(place.chapter);
  const [last, setLast] = useState(place.chapter);
  const [visible, setVisible] = useState(place);
  const placed = useRef<ComicPlace | null>(null);
  const keep = useRef<{ height: number; top: number } | null>(null);
  const zoom = useZoom({
    onTap: (_x, y, _width, height) => {
      const element = scroller.current;
      if (y < height / 3 && element) element.scrollBy({ top: -element.clientHeight * 0.8 });
      else if (y > (height * 2) / 3 && element)
        element.scrollBy({ top: element.clientHeight * 0.8 });
      else onMenu();
    },
  });
  turnRef.current = (direction) =>
    scroller.current?.scrollBy({
      top: (direction === "next" ? 1 : -1) * scroller.current.clientHeight * 0.8,
    });

  // A place chosen elsewhere (contents, slider) moves the strip there.
  useEffect(() => {
    if (
      placed.current &&
      placed.current.chapter === place.chapter &&
      placed.current.page === place.page
    )
      return;
    if (place.chapter < first || place.chapter > last) {
      setFirst(place.chapter);
      setLast(place.chapter);
    }
    const target = `${chapters[place.chapter] ? loaded[place.chapter]?.index : ""}:${place.page}`;
    requestAnimationFrame(() =>
      scroller.current
        ?.querySelector(`[data-comic-page="${target}"]`)
        ?.scrollIntoView({ block: "start" }),
    );
  }, [place]);

  // A chapter added above keeps the page in view where it was.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !keep.current) return;
    element.scrollTop = keep.current.top + element.scrollHeight - keep.current.height;
    keep.current = null;
  }, [first]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const hit = document
      .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 3)
      ?.closest<HTMLElement>("[data-comic-page]");
    if (!hit) return;
    const [core, page] = hit.dataset.comicPage!.split(":").map(Number);
    const chapter = Number(
      Object.entries(loaded).find(([, found]) => found.index === core)?.[0] ?? place.chapter,
    );
    if (chapter !== visible.chapter || page !== visible.page) {
      const next = { chapter, page };
      setVisible(next);
      placed.current = next;
      onPlace(next);
    }
    // The next chapter joins near the end of the last one shown.
    if (
      element.scrollTop + element.clientHeight * 3 >= element.scrollHeight &&
      last + 1 < chapters.length
    ) {
      onLoad(last + 1);
      setLast(last + 1);
    }
  };

  const shown = Array.from({ length: last - first + 1 }, (_, step) => first + step);
  const near = (chapter: number, page: number) =>
    chapter === visible.chapter
      ? page >= visible.page - 2 && page <= visible.page + preferences.preload + 2
      : chapter === visible.chapter + 1
        ? page <= preferences.preload
        : chapter === visible.chapter - 1 && page >= (loaded[chapter]?.pages.length ?? 0) - 3;
  return (
    <div
      ref={scroller}
      className="absolute inset-0 overflow-auto overscroll-contain touch-pan-y"
      onScroll={onScroll}
      {...zoom.handlers}
    >
      <div style={{ width: `${zoom.zoom.scale * 100}%` }} className="mx-auto">
        {first > 0 && (
          <button
            type="button"
            data-comic-control
            className="block w-full py-4 text-xs text-secondary"
            onClick={() => {
              const element = scroller.current;
              if (element) keep.current = { height: element.scrollHeight, top: element.scrollTop };
              onLoad(first - 1);
              setFirst(first - 1);
            }}
          >
            {t("comic.loadPrevious")}
          </button>
        )}
        {shown.map((chapter) => {
          const found = loaded[chapter];
          return (
            <section key={chapter} aria-label={chapters[chapter]?.title}>
              {found ? (
                found.pages.map((_, page) => (
                  <div key={page} style={{ marginBottom: preferences.gap }}>
                    <ComicPageView
                      pages={pages}
                      chapter={found}
                      index={found.index}
                      page={page}
                      fit="width"
                      near={near(chapter, page)}
                    />
                  </div>
                ))
              ) : failures[chapter] ? (
                <ChapterFailure error={failures[chapter]} onRetry={() => onLoad(chapter)} />
              ) : (
                <p role="status" className="py-10 text-center text-xs text-secondary">
                  {t("comic.loadingChapter", { title: chapters[chapter]?.title ?? "" })}
                </p>
              )}
            </section>
          );
        })}
        {last + 1 >= chapters.length && (
          <p className="py-8 text-center text-xs text-secondary">{t("comic.atEnd")}</p>
        )}
      </div>
    </div>
  );
}

/** One page, or two side by side, at a time; taps and swipes turn. */
function ComicPaged({
  pages,
  chapters,
  chapter,
  failure,
  place,
  doubled,
  preferences,
  onTurn,
  onRetry,
  onMenu,
}: {
  pages: ComicPages;
  chapters: readonly TocEntry[];
  chapter: ComicChapter | undefined;
  failure: string | undefined;
  place: ComicPlace;
  doubled: boolean;
  preferences: ComicPreferences;
  onTurn: (direction: "next" | "previous") => void;
  onRetry: () => void;
  onMenu: () => void;
}) {
  const rtl = preferences.direction === "right_to_left";
  const zoom = useZoom({
    onTap: (x, _y, width) => {
      if (x < width / 3) onTurn(rtl ? "next" : "previous");
      else if (x > (width * 2) / 3) onTurn(rtl ? "previous" : "next");
      else onMenu();
    },
    // Swiping left moves on in a left-to-right book, back in a manga.
    onSwipe: (direction) => onTurn((direction === -1) !== rtl ? "next" : "previous"),
  });
  const { reset } = zoom;
  useEffect(() => reset(), [place, reset]);
  const shown = chapter
    ? [place.page, ...(doubled && place.page + 1 < chapter.pages.length ? [place.page + 1] : [])]
    : [];
  if (rtl) shown.reverse();
  return (
    <div
      className={`absolute inset-0 flex justify-center ${
        // A page fitted to the width may be taller than the screen, and scrolls.
        preferences.fit === "width" && zoom.zoom.scale <= 1
          ? "items-start overflow-y-auto touch-pan-y"
          : "items-center overflow-hidden touch-none"
      }`}
      aria-label={chapters[place.chapter]?.title}
      {...zoom.handlers}
    >
      {failure && !chapter ? (
        <ChapterFailure error={failure} onRetry={onRetry} />
      ) : chapter ? (
        <div
          className={`flex w-full justify-center ${preferences.fit === "width" ? "items-start" : "h-full items-center"}`}
          style={{
            transform: `translate(${zoom.zoom.x}px, ${zoom.zoom.y}px) scale(${zoom.zoom.scale})`,
          }}
        >
          {shown.map((page) => (
            <div
              key={`${chapter.index}:${page}`}
              className={`flex items-center justify-center ${preferences.fit === "width" ? "" : "h-full"} ${doubled ? "w-1/2" : "w-full"}`}
            >
              <ComicPageView
                pages={pages}
                chapter={chapter}
                index={chapter.index}
                page={page}
                fit={preferences.fit}
                near
              />
            </div>
          ))}
        </div>
      ) : (
        <p role="status" className="text-xs text-secondary">
          {t("comic.loadingChapter", { title: chapters[place.chapter]?.title ?? "" })}
        </p>
      )}
    </div>
  );
}

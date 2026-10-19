import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { PageCancelled, type ComicPages, type ComicPlace } from "../../application/comic";
import { tapZone, type TapAction, type TapZones } from "../../reader/gestures";
import type { ComicChapter, ComicPreferences, TocEntry } from "../../types/generated";
import { t } from "../../i18n";
import { describeError } from "../Cloud/format";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import type { ComicSession } from "./use-comic-session";
import { useZoom } from "./use-zoom";

const BACKGROUNDS: Record<ComicPreferences["background"], string> = {
  // The reader's page colour, from its 界面 preset.
  theme: "",
  black: "bg-black",
  white: "bg-white",
};

/** Whether two pages fit side by side. */
export function wide() {
  return window.innerWidth >= 700 && window.innerWidth > window.innerHeight;
}

/** The tap zone's action; a right-to-left book reads the zones mirrored. */
function zoneAction(
  zones: TapZones,
  mirrored: boolean,
  x: number,
  y: number,
  width: number,
  height: number,
): TapAction {
  return tapZone({ x: mirrored ? width - x : x, y }, width, height, zones);
}

/**
 * One page: its box sized before the image arrives (3:4 until the size is
 * known), then the image, or a retry. A page that grows while entirely
 * above the strip's view moves the view by as much, so what is read stays
 * put on every WebView.
 */
function ComicPageView({
  pages,
  chapter,
  page,
  fit,
  near,
  scroller,
}: {
  pages: ComicPages;
  chapter: ComicChapter;
  page: number;
  fit: ComicPreferences["fit"];
  /** Close enough to the screen to load. */
  near: boolean;
  /** The strip's scroller, whose view a resize above it keeps. */
  scroller?: MutableRefObject<HTMLDivElement | null>;
}) {
  const index = chapter.index;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState(() => {
    const known = chapter.pages[page];
    return known && known.width > 0 ? { width: known.width, height: known.height } : null;
  });
  const box = useRef<HTMLDivElement>(null);
  const height = useRef(0);
  useEffect(() => {
    if (!near) return;
    let active = true;
    setFailed(null);
    pages.hold(index, page);
    pages.page(index, page).then(
      (found) => active && setUrl(found),
      (failure: unknown) =>
        // Dropped because the reader moved away: asked again when near.
        active && !(failure instanceof PageCancelled) && setFailed(describeError(failure)),
    );
    return () => {
      active = false;
      pages.release(index, page);
    };
  }, [pages, index, page, near, attempt]);
  useLayoutEffect(() => {
    const element = box.current;
    const view = scroller?.current;
    if (!element) return;
    const before = height.current;
    height.current = element.offsetHeight;
    if (!view || !before || height.current === before) return;
    if (element.getBoundingClientRect().bottom <= view.getBoundingClientRect().top + 1)
      view.scrollTop += height.current - before;
  }, [size, scroller]);
  const ratio = size ? `${size.width} / ${size.height}` : "3 / 4";
  const sizing =
    fit === "width"
      ? "w-full"
      : fit === "height"
        ? "h-full w-auto max-w-none"
        : "max-h-full max-w-full";
  return (
    <div
      ref={box}
      data-comic-page={`${index}:${page}`}
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

export interface ComicSurfaceProps {
  session: ComicSession;
  preferences: ComicPreferences;
  /** The reading menu is shown: the page number hides under it. */
  controls: boolean;
  /** A tap zone's action. */
  onAction: (action: TapAction) => void;
  onBack: () => void;
  /** The strip's turn (by most of a screen), for the reader's turn and volume keys. */
  stripTurn: MutableRefObject<((direction: "next" | "previous") => void) | null>;
}

/**
 * A comic's pages in the reader, under its menus: the strip (条漫), or one
 * page (two on a wide screen) at a time, while opening a spinner, and a
 * failure to open with retry and back.
 */
export function ComicSurface({
  session,
  preferences,
  controls,
  onAction,
  onBack,
  stripTurn,
}: ComicSurfaceProps) {
  const [offline, setOffline] = useState(() => navigator.onLine === false);
  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const { pages, place, current, chapters } = session;
  const background = BACKGROUNDS[preferences.background];
  const count = current?.pages.length ?? 0;
  const zones = preferences.tapZones as unknown as TapZones;
  return (
    <div
      className={`absolute inset-0 overflow-hidden ${background}`}
      data-testid="comic-reader"
      data-comic-mode={preferences.mode}
    >
      {session.opening ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-error max-w-sm">
            {t("comic.openFailed", { error: session.opening })}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onBack}>
              {t("common.back")}
            </Button>
            <Button size="sm" onClick={() => session.reload()}>
              {t("common.retry")}
            </Button>
          </div>
        </div>
      ) : !place || !pages ? (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-secondary"
        >
          <Icon name="progress_activity" size={28} className="animate-spin text-primary" />
          {t("comic.opening")}
        </div>
      ) : preferences.mode === "scroll" ? (
        <ComicStrip
          pages={pages}
          chapters={chapters}
          session={session}
          place={place}
          preferences={preferences}
          zones={zones}
          onAction={onAction}
          turnRef={stripTurn}
        />
      ) : (
        <ComicPaged
          pages={pages}
          chapters={chapters}
          chapter={current}
          failure={session.failures[place.chapter]}
          place={place}
          doubled={preferences.mode === "double" && wide()}
          preferences={preferences}
          zones={zones}
          onAction={onAction}
          onSwipe={(direction) => onAction(direction)}
          onRetry={() => void session.loadChapter(place.chapter).catch(() => undefined)}
        />
      )}
      {offline && (
        <p className="pointer-events-none absolute top-[calc(env(safe-area-inset-top)+0.5rem)] inset-x-0 z-[2] text-center text-[11px] text-secondary">
          {t("comic.offline")}
        </p>
      )}
      {preferences.pageNumber && place && count > 0 && !controls && (
        <span className="pointer-events-none absolute bottom-[calc(env(safe-area-inset-bottom)+0.4rem)] right-3 z-[2] rounded-full bg-black/45 px-2 py-0.5 text-[11px] text-white">
          {t("comic.page", { page: place.page + 1, count })}
        </span>
      )}
    </div>
  );
}

/** The strip's width before zooming: a phone's width, at most this much of a wide screen. */
const STRIP_WIDTH = 760;

/** How many places the strip reported that may still come back as `place`. */
const ECHOES = 32;

/**
 * 条漫: chapters one after another in a vertical strip. The next chapter
 * joins when its predecessor's end comes near; the previous one is a tap
 * at the top. The page a third of the way down the screen is the place.
 * Places the strip reported itself never scroll it again, and nothing
 * scrolls it while a finger is down.
 */
function ComicStrip({
  pages,
  chapters,
  session,
  place,
  preferences,
  zones,
  onAction,
  turnRef,
}: {
  pages: ComicPages;
  chapters: readonly TocEntry[];
  session: ComicSession;
  place: ComicPlace;
  preferences: ComicPreferences;
  zones: TapZones;
  onAction: (action: TapAction) => void;
  turnRef: MutableRefObject<((direction: "next" | "previous") => void) | null>;
}) {
  const { loaded, failures } = session;
  const scroller = useRef<HTMLDivElement | null>(null);
  const [first, setFirst] = useState(place.chapter);
  const [last, setLast] = useState(place.chapter);
  const [visible, setVisible] = useState(place);
  /** Places reported, oldest first, until they come back. */
  const echoes = useRef<string[]>([]);
  const keep = useRef<{ height: number; top: number } | null>(null);
  const zoom = useZoom({
    onTap: (x, y, width, height) => onAction(zoneAction(zones, false, x, y, width, height)),
  });
  turnRef.current = (direction) =>
    scroller.current?.scrollBy({
      top: (direction === "next" ? 1 : -1) * scroller.current.clientHeight * 0.8,
    });

  // A place chosen elsewhere (contents, slider, chapter buttons) moves the strip there.
  useEffect(() => {
    const key = `${place.chapter}:${place.page}`;
    const echoed = echoes.current.indexOf(key);
    if (echoed >= 0) {
      echoes.current = echoes.current.slice(echoed + 1);
      return;
    }
    if (zoom.pressed()) return;
    if (place.chapter < first || place.chapter > last) {
      setFirst(place.chapter);
      setLast(place.chapter);
    }
    setVisible(place);
    const target = `${loaded[place.chapter]?.index ?? ""}:${place.page}`;
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

  // Zooming keeps the middle of the view where it was.
  const scale = useRef(zoom.zoom.scale);
  useLayoutEffect(() => {
    const element = scroller.current;
    const ratio = zoom.zoom.scale / scale.current;
    scale.current = zoom.zoom.scale;
    if (!element || ratio === 1) return;
    const middle = element.clientHeight / 2;
    const centre = element.clientWidth / 2;
    element.scrollTop = (element.scrollTop + middle) * ratio - middle;
    element.scrollLeft = (element.scrollLeft + centre) * ratio - centre;
  }, [zoom.zoom.scale]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const hit = document
      .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 3)
      ?.closest<HTMLElement>("[data-comic-page]");
    if (hit) {
      const [core, page] = hit.dataset.comicPage!.split(":").map(Number);
      const chapter = Number(
        Object.entries(loaded).find(([, found]) => found.index === core)?.[0] ?? visible.chapter,
      );
      if (chapter !== visible.chapter || page !== visible.page) {
        const next = { chapter, page };
        setVisible(next);
        echoes.current = [...echoes.current, `${chapter}:${page}`].slice(-ECHOES);
        session.setPlace(next);
      }
    }
    // The next chapter joins near the end of the last one shown.
    if (
      element.scrollTop + element.clientHeight * 3 >= element.scrollHeight &&
      last + 1 < chapters.length
    ) {
      void session.loadChapter(last + 1).catch(() => undefined);
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
      className="absolute inset-0 overflow-auto overscroll-contain touch-pan-y [overflow-anchor:none]"
      onScroll={onScroll}
      {...zoom.handlers}
    >
      <div
        style={{ width: `calc(min(100%, ${STRIP_WIDTH}px) * ${zoom.zoom.scale})` }}
        className="mx-auto"
      >
        {first > 0 && (
          <button
            type="button"
            data-comic-control
            className="block w-full py-4 text-xs text-secondary"
            onClick={() => {
              const element = scroller.current;
              if (element) keep.current = { height: element.scrollHeight, top: element.scrollTop };
              void session.loadChapter(first - 1).catch(() => undefined);
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
                      page={page}
                      fit="width"
                      near={near(chapter, page)}
                      scroller={scroller}
                    />
                  </div>
                ))
              ) : failures[chapter] ? (
                <ChapterFailure
                  error={failures[chapter]}
                  onRetry={() => void session.loadChapter(chapter).catch(() => undefined)}
                />
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

/**
 * One page, or two side by side, at a time, in the middle of the screen; a
 * page fitted to the width that is taller than the screen scrolls from its
 * top. Taps go through the tap zones (mirrored right to left) and swipes
 * turn.
 */
function ComicPaged({
  pages,
  chapters,
  chapter,
  failure,
  place,
  doubled,
  preferences,
  zones,
  onAction,
  onSwipe,
  onRetry,
}: {
  pages: ComicPages;
  chapters: readonly TocEntry[];
  chapter: ComicChapter | undefined;
  failure: string | undefined;
  place: ComicPlace;
  doubled: boolean;
  preferences: ComicPreferences;
  zones: TapZones;
  onAction: (action: TapAction) => void;
  onSwipe: (direction: "next" | "previous") => void;
  onRetry: () => void;
}) {
  const rtl = preferences.direction === "right_to_left";
  const box = useRef<HTMLDivElement>(null);
  const zoom = useZoom({
    onTap: (x, y, width, height) => onAction(zoneAction(zones, rtl, x, y, width, height)),
    // Swiping left moves on in a left-to-right book, back in a manga.
    onSwipe: (direction) => onSwipe((direction === -1) !== rtl ? "next" : "previous"),
  });
  const { reset } = zoom;
  useEffect(() => {
    reset();
    if (box.current) box.current.scrollTop = 0;
  }, [place, reset]);
  const shown = chapter
    ? [place.page, ...(doubled && place.page + 1 < chapter.pages.length ? [place.page + 1] : [])]
    : [];
  if (rtl) shown.reverse();
  const byWidth = preferences.fit === "width";
  return (
    <div
      ref={box}
      className={`absolute inset-0 ${
        // A page fitted to the width may be taller than the screen, and scrolls.
        byWidth && zoom.zoom.scale <= 1
          ? "overflow-y-auto touch-pan-y"
          : "overflow-hidden touch-none"
      }`}
      aria-label={chapters[place.chapter]?.title}
      {...zoom.handlers}
    >
      <div
        className={`${byWidth ? "min-h-full" : "h-full"} w-full flex items-center justify-center`}
      >
        {failure && !chapter ? (
          <ChapterFailure error={failure} onRetry={onRetry} />
        ) : chapter ? (
          <div
            data-comic-spread
            className={`flex w-full items-center justify-center ${byWidth ? "" : "h-full"}`}
            style={{
              transform: `translate(${zoom.zoom.x}px, ${zoom.zoom.y}px) scale(${zoom.zoom.scale})`,
            }}
          >
            {shown.map((page) => (
              <div
                key={`${chapter.index}:${page}`}
                className={`flex items-center justify-center ${byWidth ? "" : "h-full"} ${doubled ? "w-1/2" : "w-full"}`}
              >
                <ComicPageView
                  pages={pages}
                  chapter={chapter}
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
    </div>
  );
}

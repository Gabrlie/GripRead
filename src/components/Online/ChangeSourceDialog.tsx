import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type {
  ChangeOnlineSourceResult,
  LibraryBook,
  OnlineBook,
  OnlineChapter,
  OnlineSearchEvent,
} from "../../types/generated";

function originKey(origin: OnlineBook): string {
  return `${origin.sourceUrl}\n${origin.bookUrl}`;
}

/** The line under a candidate: its latest chapter and size once loaded. */
function describe(
  origin: OnlineBook,
  loaded: { book: OnlineBook; chapters: OnlineChapter[] } | "failed" | undefined,
  checkAuthor: boolean,
): string {
  const latest =
    loaded && loaded !== "failed"
      ? loaded.book.latestChapterTitle ||
        loaded.chapters.filter((chapter) => !chapter.isVolume).at(-1)?.title ||
        ""
      : origin.latestChapterTitle;
  const size =
    loaded && loaded !== "failed"
      ? t("detail.chapters", {
          count: loaded.chapters.filter((chapter) => !chapter.isVolume).length,
        })
      : "";
  const parts = [checkAuthor ? "" : origin.author, latest, size].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return loaded === "failed" ? t("change.failedRead") : loaded ? "—" : t("change.loadingLatest");
}
import { ALL_SOURCES, mergeOnlineBook } from "../../application/online";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { t } from "../../i18n";
import { describeError } from "../Cloud/format";

/**
 * Legado's 换源: every enabled source is searched for the book's name; the
 * copies with the same name (and author, with 校验作者 on) are listed, and
 * choosing one moves the book there, keeping its records.
 */
export function ChangeSourceDialog({
  service,
  book,
  prepare,
  onChanged,
  onClose,
}: {
  service: SourceService;
  book: LibraryBook;
  /** Runs before switching, such as saving the reader's current place. */
  prepare?: () => Promise<void>;
  onChanged: (result: ChangeOnlineSourceResult) => void;
  onClose: () => void;
}) {
  const online = book.online!;
  const [event, setEvent] = useState<OnlineSearchEvent | null>(null);
  const [checkAuthor, setCheckAuthor] = useState(true);
  const [filter, setFilter] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const operation = useRef(`change-${Date.now()}`);
  // 停止 ends the search; 继续 searches again, keeping the rows found.
  const [round, setRound] = useState(0);
  const [stopped, setStopped] = useState(false);
  const found = useRef(new Map<string, OnlineSearchEvent["results"][number]>());

  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    const operationId = `change-${Date.now()}-${round}`;
    operation.current = operationId;
    void service
      .onSearch((next) => {
        if (next.operationId !== operationId) return;
        for (const result of next.results)
          found.current.set(
            `${result.name}\n${result.author}\n${result.origins[0]?.comic ?? false}`,
            result,
          );
        setEvent({ ...next, results: [...found.current.values()] });
      })
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        stop = unsubscribe;
        return service.search({
          operationId,
          key: book.book.title,
          // A comic moves only to comic sources, a novel only to text ones.
          scope: { ...ALL_SOURCES, comic: online.book.comic },
          precise: true,
          page: 1,
        });
      })
      .catch((failure: unknown) => toast({ text: describeError(failure), error: true }));
    return () => {
      active = false;
      stop?.();
      void service.cancel(operationId);
    };
  }, [service, book.book.title, online.book.comic, round]);

  // Rows keep the order they first appeared in, so choosing one while the
  // search goes on never hits a row that moved.
  const seen = useRef(new Map<string, number>());
  const candidates = useMemo(() => {
    const author = (book.book.author ?? online.book.author).trim();
    const query = filter.trim();
    return (event?.results ?? [])
      .filter(
        (result) =>
          result.name.trim() === book.book.title.trim() &&
          (!checkAuthor || !author || result.author.trim() === author),
      )
      .flatMap((result) => result.origins)
      .filter((origin) => origin.comic === online.book.comic)
      .filter((origin) => !query || origin.sourceName.includes(query))
      .map((origin) => {
        const key = originKey(origin);
        if (!seen.current.has(key)) seen.current.set(key, seen.current.size);
        return origin;
      })
      .sort((a, b) => seen.current.get(originKey(a))! - seen.current.get(originKey(b))!);
  }, [event, checkAuthor, filter, book, online]);

  // Legado's 换源 loads each candidate's details and contents so the list
  // can show the latest chapter and size; they are reused when chosen.
  const [loaded, setLoaded] = useState<
    Record<string, { book: OnlineBook; chapters: OnlineChapter[] } | "failed">
  >({});
  const queued = useRef(new Set<string>());
  const loading = useRef(0);
  const pump = useRef<() => void>(() => undefined);
  pump.current = () => {
    for (const origin of candidates) {
      if (loading.current >= 3) return;
      const key = originKey(origin);
      if (queued.current.has(key) || origin.sourceUrl === online.book.sourceUrl) continue;
      queued.current.add(key);
      loading.current++;
      void service
        .bookInfo(origin)
        .then(async (info) => {
          const book = mergeOnlineBook(origin, info);
          const chapters = await service.chapters(book);
          setLoaded((current) => ({ ...current, [key]: { book, chapters } }));
        })
        .catch(() => setLoaded((current) => ({ ...current, [key]: "failed" })))
        .finally(() => {
          loading.current--;
          pump.current();
        });
    }
  };
  useEffect(() => pump.current(), [candidates]);

  const choose = (origin: OnlineBook) => {
    setSwitching(origin.sourceUrl);
    void (async () => {
      const ready = loaded[originKey(origin)];
      const info =
        ready && ready !== "failed"
          ? ready.book
          : mergeOnlineBook(origin, await service.bookInfo(origin));
      const chapters = ready && ready !== "failed" ? ready.chapters : await service.chapters(info);
      await prepare?.();
      const result = await service.changeSource({ bookId: book.book.id, book: info, chapters });
      toast(
        result.certain
          ? t("change.done", { source: info.sourceName })
          : t("change.doneUncertain", { source: info.sourceName }),
      );
      onChanged(result);
    })()
      .catch((failure: unknown) =>
        toast({ text: t("change.failed", { error: describeError(failure) }), error: true }),
      )
      .finally(() => setSwitching(null));
  };

  const running = !stopped && event !== null && !event.done;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        initialFocus={false}
        className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md h-[70dvh] p-5 gap-3 flex flex-col"
      >
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("detail.changeSource")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <input
            aria-label={t("change.filter")}
            placeholder={t("field.source-name")}
            value={filter}
            onChange={(change) => setFilter(change.target.value)}
            className="flex-1 min-w-0 h-9 rounded-lg bg-surface-container-low px-3 text-sm outline-none"
          />
          <button
            type="button"
            aria-pressed={checkAuthor}
            onClick={() => setCheckAuthor((value) => !value)}
            className={`h-8 px-3 rounded-full text-xs shrink-0 ${
              checkAuthor ? "bg-primary text-on-primary" : "bg-surface-container-low text-secondary"
            }`}
          >
            {t("change.checkAuthor")}
          </button>
        </div>
        <div className="flex items-center gap-2 h-7">
          <p role="status" className="flex-1 text-[11px] text-secondary">
            {running
              ? t("change.searching", {
                  done: event.searched,
                  total: event.total,
                  found: candidates.length,
                })
              : stopped
                ? t("change.stopped", { found: candidates.length })
                : event
                  ? t("change.found", { found: candidates.length })
                  : t("search.searching")}
          </p>
          {running && !stopped ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => {
                setStopped(true);
                void service.cancel(operation.current);
              }}
            >
              {t("search.stop")}
            </Button>
          ) : (
            stopped && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => {
                  setStopped(false);
                  setRound((value) => value + 1);
                }}
              >
                {t("downloads.resume")}
              </Button>
            )
          )}
        </div>
        <ul className="flex-1 min-h-0 overflow-y-auto space-y-1" aria-label={t("change.list")}>
          {candidates.map((origin) => {
            const current = origin.sourceUrl === online.book.sourceUrl;
            return (
              <li key={`${origin.sourceUrl}\n${origin.bookUrl}`}>
                <button
                  type="button"
                  disabled={switching !== null || current}
                  onClick={() => choose(origin)}
                  className="w-full h-14 text-left rounded-lg px-3 hover:bg-surface-container-low disabled:opacity-70 flex items-center gap-2"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{origin.sourceName}</span>
                    <span className="block text-[11px] text-secondary truncate">
                      {describe(origin, loaded[originKey(origin)], checkAuthor)}
                    </span>
                  </span>
                  {current && <Icon name="check" size={15} className="text-primary shrink-0" />}
                  {switching === origin.sourceUrl && (
                    <span className="text-[11px] text-secondary shrink-0">
                      {t("change.switching")}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

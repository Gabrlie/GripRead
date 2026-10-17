import { useContext, useEffect, useState } from "react";
import { RuntimeContext } from "../../application/runtime";
import type { SourceService } from "../../services/contracts";
import type {
  LibraryBook,
  OnlineBook,
  OnlineChapter,
  OnlineSearchResult,
} from "../../types/generated";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Icon } from "../ui/Icon";
import { copyText } from "../../services/system";
import { toast } from "../ui/toast";
import { OnlineCover } from "./OnlineCover";
import { OnlineTocPage } from "./OnlineTocPage";
import { keepOnlineCover, mergeOnlineBook } from "../../application/online";
import { t } from "../../i18n";
import { introLabel, useIntroTranslation } from "./use-title-translation";
import { TranslatedMark } from "./TitleTranslationChip";
import { describeError } from "../Cloud/format";

/** Opens a kept online book in the reader, at a chapter when one is given. */
export type OpenOnlineBook = (book: LibraryBook, origin: number, chapter: number | null) => void;

/**
 * Legado's 书籍详情 for an online book: details from the chosen source, the
 * other sources that have it (换源), its contents on their own page,
 * 加入书架 or 移出书架, and 阅读.
 */
export function OnlineBookPage({
  service,
  result,
  initialOrigin = 0,
  onRead,
  onClose,
}: {
  service: SourceService;
  result: OnlineSearchResult;
  initialOrigin?: number;
  onRead?: OpenOnlineBook;
  onClose: () => void;
}) {
  const [originIndex, setOriginIndex] = useState(initialOrigin);
  const [book, setBook] = useState<OnlineBook | null>(null);
  const [chapters, setChapters] = useState<OnlineChapter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showChapters, setShowChapters] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [kept, setKept] = useState<LibraryBook | null>(null);
  const [busy, setBusy] = useState(false);
  const runtime = useContext(RuntimeContext);
  const origin = result.origins[originIndex] ?? result.origins[0];

  useEffect(() => {
    let active = true;
    void service.findOnlineBook(result.name, result.author).then(
      (found) => active && setKept(found),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [service, result.name, result.author]);

  useEffect(() => {
    if (!origin) return;
    let active = true;
    setLoading(true);
    setError(null);
    setBook(null);
    setChapters(null);
    // Kept copies show at once; 刷新 asks the source again.
    const fresh = refresh > 0;
    void service
      .bookInfo(origin, fresh)
      .then((info) => {
        if (!active) return;
        const merged = mergeOnlineBook(origin, info);
        setBook(merged);
        return service.chapters(merged, fresh).then((list) => active && setChapters(list));
      })
      .catch((failure: unknown) => active && setError(describeError(failure)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [service, origin, refresh]);

  const shown = book ?? origin;
  const intro = useIntroTranslation(shown?.intro);
  if (!shown) return null;
  const onShelf = Boolean(kept?.online?.onShelf);
  // The shelf's copy keeps its own source until it is switched (换源).
  const keptHere = kept?.online?.book.sourceUrl === origin?.sourceUrl;

  /** The book as kept on the device, adding it with these details when needed. */
  const keep = async (shelf: boolean): Promise<LibraryBook> => {
    if (kept && (keptHere || !book || !chapters)) {
      // A copy read before without adding it joins the shelf as it is.
      if (shelf && !kept.online?.onShelf) {
        await service.setOnShelf(kept.book.id, true);
        const added = await service.getLibraryBook(kept.book.id);
        setKept(added);
        void keepOnlineCover(service, added);
        void runtime?.library.refresh();
        return added;
      }
      return kept;
    }
    if (!book || !chapters) throw new Error(t("onlineBook.notReady"));
    const entry = await service.addOnlineBook({ book, chapters, onShelf: shelf });
    if (shelf) {
      setKept(entry);
      void keepOnlineCover(service, entry);
      // The shelf lists the book at once, not after its next refresh.
      void runtime?.library.refresh();
    }
    return entry;
  };

  const act = (work: () => Promise<void>) => {
    setBusy(true);
    void work()
      .catch((failure: unknown) => toast({ text: describeError(failure), error: true }))
      .finally(() => setBusy(false));
  };

  const read = (chapter: number | null) =>
    act(async () => {
      const entry = await keep(false);
      onRead?.(entry, originIndex, chapter);
    });

  const toggleShelf = () =>
    act(async () => {
      if (onShelf && kept) {
        await service.setOnShelf(kept.book.id, false);
        await service.leaveOnlineBook(kept.book.id);
        setKept(null);
        void runtime?.library.refresh();
        toast(t("onlineBook.removed"));
        return;
      }
      await keep(true);
      toast(t("onlineBook.added"));
    });

  const actions = (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("reader.more")}
        className="h-9 w-9 rounded-full inline-flex items-center justify-center text-secondary hover:bg-surface-container"
      >
        <Icon name="more_vert" size={19} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onClick={() => void copyText(shown.bookUrl).then(() => toast(t("onlineBook.urlCopied")))}
        >
          <Icon name="link" size={15} />
          {t("onlineBook.copyUrl")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!book?.tocUrl}
          onClick={() =>
            book && void copyText(book.tocUrl).then(() => toast(t("onlineBook.tocCopied")))
          }
        >
          <Icon name="toc_rule" size={15} />
          {t("onlineBook.copyToc")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setRefresh((value) => value + 1)}>
          <Icon name="refresh" size={15} />
          {t("logs.refresh")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <FullPage label={t("detail.title")} onClose={onClose} actions={actions} layer="z-[45]">
      <div className="flex gap-4">
        <div className="w-24 h-32 shrink-0 rounded-md overflow-hidden shadow-sm bg-surface-container">
          <OnlineCover
            service={service}
            sourceUrl={shown.sourceUrl}
            url={shown.coverUrl || result.coverUrl}
            title={shown.name}
          />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <h2 className="font-title-editorial text-lg font-semibold leading-snug">{shown.name}</h2>
          <p className="text-xs text-secondary">{shown.author || t("shelf.unknownAuthor")}</p>
          {shown.kind && (
            <div className="flex flex-wrap gap-1">
              {shown.kind
                .split(",")
                .filter(Boolean)
                .slice(0, 6)
                .map((kind) => (
                  <span
                    key={kind}
                    className="rounded px-1.5 text-[10px] leading-5 bg-surface-container-low text-secondary"
                  >
                    {kind}
                  </span>
                ))}
            </div>
          )}
          {shown.wordCount && <p className="text-[11px] text-secondary">{shown.wordCount}</p>}
          {shown.latestChapterTitle && (
            <p className="text-[11px] text-secondary truncate">
              {t("shelf.latest", { chapter: shown.latestChapterTitle })}
            </p>
          )}
          {onShelf && (
            <p className="text-[11px] text-primary">
              {t("onlineBook.onShelf", {
                where: keptHere ? "" : ` (${kept?.online?.book.sourceName})`,
              })}
            </p>
          )}
          {kept && !onShelf && kept.online?.readChapterTitle && (
            <p className="text-[11px] text-secondary truncate">
              {t("onlineBook.lastRead", { chapter: kept.online.readChapterTitle })}
            </p>
          )}
        </div>
      </div>

      <section className="rounded-xl bg-surface-container-low px-3 py-2.5 flex items-center gap-2">
        <Icon name="public" size={15} className="text-secondary" />
        <span className="flex-1 min-w-0 text-sm truncate">
          {t("onlineBook.source", { source: origin?.sourceName ?? "" })}
        </span>
        {result.origins.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="h-7 px-2.5 rounded-full text-xs bg-surface-container text-primary">
              {t("onlineBook.change", { count: result.origins.length })}
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-80 overflow-y-auto">
              {result.origins.map((item, index) => (
                <DropdownMenuItem key={item.sourceUrl} onClick={() => setOriginIndex(index)}>
                  <Icon
                    name="check"
                    size={15}
                    className={index === originIndex ? "" : "opacity-0"}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{item.sourceName}</span>
                    {item.latestChapterTitle && (
                      <span className="block text-[10px] text-secondary truncate">
                        {item.latestChapterTitle}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </section>

      {shown.intro && (
        <section className="rounded-xl bg-surface-container-low p-3">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-[11px] text-secondary flex items-center gap-1.5">
              {t("detail.intro")}
              {intro.on && <TranslatedMark />}
            </h3>
            {intro.available && (
              <button
                type="button"
                className="text-[11px] text-primary disabled:opacity-60"
                disabled={intro.busy}
                onClick={intro.toggle}
              >
                {introLabel(intro)}
              </button>
            )}
          </div>
          <p data-selectable="true" className="text-sm leading-relaxed whitespace-pre-wrap">
            {intro.text}
          </p>
        </section>
      )}

      {loading && (
        <p role="status" className="text-xs text-secondary px-1">
          {t("onlineBook.loading")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-error break-words px-1">
          {error}
        </p>
      )}

      {chapters && (
        <button
          type="button"
          className="w-full rounded-xl bg-surface-container-low flex items-center gap-2 px-3 py-2.5 text-sm text-left"
          onClick={() => setShowChapters(true)}
        >
          <span className="flex-1 min-w-0 truncate">
            {t("onlineBook.contents", {
              count: chapters.filter((chapter) => !chapter.isVolume).length,
            })}
            {book?.latestChapterTitle && (
              <span className="ml-2 text-[11px] text-secondary">{book.latestChapterTitle}</span>
            )}
          </span>
          <Icon name="chevron_right" size={16} className="text-secondary" />
        </button>
      )}

      <div className="sticky bottom-0 -mx-3 px-3 pt-2 pb-3 bg-surface flex gap-2">
        <Button
          variant="outline"
          className="flex-1"
          disabled={busy || (!onShelf && (!book || !chapters))}
          onClick={toggleShelf}
        >
          {onShelf ? t("detail.remove") : t("reader.addToShelf")}
        </Button>
        <Button
          className="flex-1"
          disabled={busy || !onRead || (!(onShelf && kept) && (!book || !chapters?.length))}
          onClick={() => read(null)}
        >
          {t("onlineBook.read")}
        </Button>
      </div>

      {showChapters && book && chapters && (
        <OnlineTocPage
          bookName={book.name}
          chapters={chapters}
          onChoose={(index) => {
            setShowChapters(false);
            read(index);
          }}
          onClose={() => setShowChapters(false)}
        />
      )}
    </FullPage>
  );
}

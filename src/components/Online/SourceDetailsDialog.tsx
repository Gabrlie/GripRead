import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type { OnlineBook, OnlineSearchEvent } from "../../types/generated";
import { ALL_SOURCES } from "../../application/online";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "../ui/toast";
import { OnlineCover } from "./OnlineCover";
import { t } from "../../i18n";

/**
 * Legado's 换封面: every enabled source is searched for the title, and a
 * found copy's cover can be kept as this book's cover, local or online.
 */
export function SourceDetailsDialog({
  service,
  title,
  author,
  onCover,
  onClose,
}: {
  service: SourceService;
  title: string;
  author: string;
  onCover: (book: OnlineBook) => Promise<void>;
  onClose: () => void;
}) {
  const [event, setEvent] = useState<OnlineSearchEvent | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const operation = useRef(`details-${Date.now()}`);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    const operationId = operation.current;
    void service
      .onSearch((next) => next.operationId === operationId && setEvent(next))
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        stop = unsubscribe;
        return service.search({
          operationId,
          key: title,
          scope: ALL_SOURCES,
          precise: true,
          page: 1,
        });
      })
      .catch((failure: unknown) => toast({ text: String(failure), error: true }));
    return () => {
      active = false;
      stop?.();
      void service.cancel(operationId);
    };
  }, [service, title]);

  // Copies with a cover keep the place they first appeared in, so loading
  // images never moves the cards.
  const seen = useRef(new Map<string, number>());
  const found = useMemo(() => {
    const books = (event?.results ?? [])
      .filter((result) => result.name.trim() === title.trim())
      .sort((a, b) => Number(b.author === author) - Number(a.author === author))
      .flatMap((result) => result.origins)
      .filter((book) => book.coverUrl);
    for (const book of books) {
      const key = `${book.sourceUrl}\n${book.bookUrl}`;
      if (!seen.current.has(key)) seen.current.set(key, seen.current.size);
    }
    const order = (book: OnlineBook) => seen.current.get(`${book.sourceUrl}\n${book.bookUrl}`)!;
    return books.sort((a, b) => order(a) - order(b));
  }, [event, title, author]);

  const act = (book: OnlineBook, work: () => Promise<void>) => {
    setBusy(`${book.sourceUrl}\n${book.bookUrl}`);
    void work()
      .catch((failure: unknown) => toast({ text: String(failure), error: true }))
      .finally(() => setBusy(null));
  };

  const running = event !== null && !event.done;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-lg h-[70dvh] p-5 gap-3 flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("detail.sourceCover")}
          </DialogTitle>
        </DialogHeader>
        <p role="status" className="text-[11px] text-secondary">
          {running
            ? t("cover.searching", { done: event.searched, total: event.total })
            : event
              ? t("cover.found", { found: found.length })
              : t("search.searching")}
        </p>
        <ul
          aria-label={t("cover.list")}
          className="flex-1 min-h-0 overflow-y-auto grid grid-cols-3 gap-2 content-start"
        >
          {found.map((book) => {
            const key = `${book.sourceUrl}\n${book.bookUrl}`;
            return (
              <li key={key} className="space-y-1 min-w-0">
                <div className="aspect-[3/4] rounded-md overflow-hidden bg-surface-container">
                  <OnlineCover
                    service={service}
                    sourceUrl={book.sourceUrl}
                    url={book.coverUrl}
                    title={book.name}
                  />
                </div>
                <p className="text-[11px] truncate">{book.sourceName}</p>
                <p className="text-[10px] text-secondary truncate">
                  {book.author || t("shelf.unknownAuthor")}
                </p>
                <div className="flex flex-col gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={busy !== null || !book.coverUrl}
                    onClick={() =>
                      act(book, async () => {
                        await onCover(book);
                        toast(t("cover.changed"));
                      })
                    }
                  >
                    {busy === key ? t("detail.working") : t("cover.use")}
                  </Button>
                </div>
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

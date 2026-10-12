import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type { OnlineBook, OnlineSearchEvent } from "../../types/generated";
import { ALL_SOURCES, mergeOnlineBook } from "../../application/online";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "../ui/toast";
import { OnlineCover } from "./OnlineCover";

/**
 * Legado's 换封面, with details too: every enabled source is searched for
 * the title, and a found copy's cover or its author and introduction can
 * be taken for this book, local or online. What is taken is kept.
 */
export function SourceDetailsDialog({
  service,
  title,
  author,
  onCover,
  onDetails,
  onClose,
}: {
  service: SourceService;
  title: string;
  author: string;
  onCover: (book: OnlineBook) => Promise<void>;
  onDetails: (book: OnlineBook) => void;
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

  // The same title first, then the same author, as Legado's 换封面 lists them.
  const found = useMemo(
    () =>
      (event?.results ?? [])
        .filter((result) => result.name.trim() === title.trim())
        .sort((a, b) => Number(b.author === author) - Number(a.author === author))
        .flatMap((result) => result.origins),
    [event, title, author],
  );

  const act = (book: OnlineBook, work: () => Promise<void>) => {
    setBusy(`${book.sourceUrl}\n${book.bookUrl}`);
    void work()
      .catch((failure: unknown) => toast({ text: String(failure), error: true }))
      .finally(() => setBusy(null));
  };

  const running = event !== null && !event.done;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-lg max-h-[86dvh] p-5 gap-3 flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">从书源选择封面和详情</DialogTitle>
        </DialogHeader>
        <p role="status" className="text-[11px] text-secondary">
          {running
            ? `正在搜索 ${event.searched}/${event.total}`
            : event
              ? `找到 ${found.length} 个`
              : "正在搜索…"}
        </p>
        <ul
          aria-label="书源里的这本书"
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
                <p className="text-[10px] text-secondary truncate">{book.author || "未知作者"}</p>
                <div className="flex flex-col gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={busy !== null || !book.coverUrl}
                    onClick={() =>
                      act(book, async () => {
                        await onCover(book);
                        toast("封面已更换");
                      })
                    }
                  >
                    {busy === key ? "处理中…" : "用这个封面"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    disabled={busy !== null}
                    onClick={() =>
                      act(book, async () => {
                        onDetails(mergeOnlineBook(book, await service.bookInfo(book)));
                      })
                    }
                  >
                    用这个详情
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

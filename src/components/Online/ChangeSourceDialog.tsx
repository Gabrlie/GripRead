import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type {
  ChangeOnlineSourceResult,
  LibraryBook,
  OnlineBook,
  OnlineSearchEvent,
} from "../../types/generated";
import { ALL_SOURCES } from "../../application/online";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";

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
          key: book.book.title,
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
  }, [service, book.book.title]);

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
      .filter((origin) => !query || origin.sourceName.includes(query));
  }, [event, checkAuthor, filter, book, online]);

  const choose = (origin: OnlineBook) => {
    setSwitching(origin.sourceUrl);
    void (async () => {
      const info = await service.bookInfo(origin);
      const chapters = await service.chapters(info);
      await prepare?.();
      const result = await service.changeSource({ bookId: book.book.id, book: info, chapters });
      toast(
        result.certain
          ? `已换到 ${info.sourceName}`
          : `已换到 ${info.sourceName}，没有找到对应章节，停在原来的位置附近`,
      );
      onChanged(result);
    })()
      .catch((failure: unknown) => toast({ text: `换源失败：${String(failure)}`, error: true }))
      .finally(() => setSwitching(null));
  };

  const running = event !== null && !event.done;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md max-h-[86dvh] p-5 gap-3 flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">换源</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <input
            aria-label="筛选书源"
            placeholder="书源名称"
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
            校验作者
          </button>
        </div>
        <p role="status" className="text-[11px] text-secondary">
          {running
            ? `正在搜索 ${event.searched}/${event.total}`
            : event
              ? `找到 ${candidates.length} 个书源`
              : "正在搜索…"}
        </p>
        <ul className="flex-1 min-h-0 overflow-y-auto space-y-1" aria-label="可换的书源">
          {candidates.map((origin) => {
            const current = origin.sourceUrl === online.book.sourceUrl;
            return (
              <li key={`${origin.sourceUrl}\n${origin.bookUrl}`}>
                <button
                  type="button"
                  disabled={switching !== null || current}
                  onClick={() => choose(origin)}
                  className="w-full text-left rounded-lg px-3 py-2 hover:bg-surface-container-low disabled:opacity-70 flex items-center gap-2"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{origin.sourceName}</span>
                    <span className="block text-[11px] text-secondary truncate">
                      {[checkAuthor ? "" : origin.author, origin.latestChapterTitle]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </span>
                  </span>
                  {current && <Icon name="check" size={15} className="text-primary shrink-0" />}
                  {switching === origin.sourceUrl && (
                    <span className="text-[11px] text-secondary shrink-0">正在换源…</span>
                  )}
                </button>
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

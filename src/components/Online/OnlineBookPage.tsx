import { useEffect, useState } from "react";
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
    void service
      .bookInfo(origin)
      .then((info) => {
        if (!active) return;
        setBook(info);
        return service.chapters(info).then((list) => active && setChapters(list));
      })
      .catch((failure: unknown) => active && setError(String(failure)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [service, origin, refresh]);

  const shown = book ?? origin;
  if (!shown) return null;
  const onShelf = Boolean(kept?.online?.onShelf);
  // The shelf's copy keeps its own source until it is switched (换源).
  const keptHere = kept?.online?.book.sourceUrl === origin?.sourceUrl;

  /** The book as kept on the device, adding it with these details when needed. */
  const keep = async (shelf: boolean): Promise<LibraryBook> => {
    if (kept && (keptHere || !book || !chapters)) return kept;
    if (!book || !chapters) throw new Error("详情和目录还没有读取完");
    const entry = await service.addOnlineBook({ book, chapters, onShelf: shelf });
    if (shelf) setKept(entry);
    return entry;
  };

  const act = (work: () => Promise<void>) => {
    setBusy(true);
    void work()
      .catch((failure: unknown) => toast({ text: String(failure), error: true }))
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
        toast("已移出书架");
        return;
      }
      await keep(true);
      toast("已加入书架");
    });

  const actions = (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="更多"
        className="h-9 w-9 rounded-full inline-flex items-center justify-center text-secondary hover:bg-surface-container"
      >
        <Icon name="more_vert" size={19} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onClick={() => void copyText(shown.bookUrl).then(() => toast("已复制书籍地址"))}
        >
          <Icon name="link" size={15} />
          拷贝书籍 URL
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!book?.tocUrl}
          onClick={() => book && void copyText(book.tocUrl).then(() => toast("已复制目录地址"))}
        >
          <Icon name="toc_rule" size={15} />
          拷贝目录 URL
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setRefresh((value) => value + 1)}>
          <Icon name="refresh" size={15} />
          刷新
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <FullPage label="书籍详情" onClose={onClose} actions={actions} layer="z-[45]">
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
          <p className="text-xs text-secondary">{shown.author || "未知作者"}</p>
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
            <p className="text-[11px] text-secondary truncate">最新：{shown.latestChapterTitle}</p>
          )}
          {onShelf && (
            <p className="text-[11px] text-primary">
              已在书架{keptHere ? "" : `（${kept?.online?.book.sourceName}）`}
            </p>
          )}
        </div>
      </div>

      <section className="rounded-xl bg-surface-container-low px-3 py-2.5 flex items-center gap-2">
        <Icon name="public" size={15} className="text-secondary" />
        <span className="flex-1 min-w-0 text-sm truncate">来源：{origin?.sourceName}</span>
        {result.origins.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="h-7 px-2.5 rounded-full text-xs bg-surface-container text-primary">
              换源（{result.origins.length}）
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
          <h3 className="text-[11px] text-secondary mb-1">简介</h3>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{shown.intro}</p>
        </section>
      )}

      {loading && (
        <p role="status" className="text-xs text-secondary px-1">
          正在读取详情与目录…
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
            目录（{chapters.filter((chapter) => !chapter.isVolume).length} 章）
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
          {onShelf ? "移出书架" : "加入书架"}
        </Button>
        <Button
          className="flex-1"
          disabled={busy || !onRead || (!(onShelf && kept) && (!book || !chapters?.length))}
          onClick={() => read(null)}
        >
          阅读
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

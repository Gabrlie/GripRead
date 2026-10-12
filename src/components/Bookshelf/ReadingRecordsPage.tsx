import { useEffect, useState } from "react";
import { useLibrary, useRuntime } from "../../application/runtime";
import type { BookReadingTime, LibraryBook, ReadingStats } from "../../types/generated";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { ActivityMatrix } from "./ActivityMatrix";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { usePageLayer } from "../Layout/use-page-layer";
import { BookCover } from "./BookCover";
import { LibraryCover } from "./LibraryCover";
import { formatDuration, localDay } from "../../application/reading-time";

/** Legado's 阅读记录: total and daily reading time, and time per book. */
export function ReadingRecordsPage({
  onClose,
  onOpenBook,
}: {
  onClose: () => void;
  onOpenBook: (book: LibraryBook) => void;
}) {
  const runtime = useRuntime();
  const { state: library } = useLibrary();
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const page = usePageLayer(onClose);
  useEffect(() => {
    let cancelled = false;
    // Books in the 回收站 keep their records and are listed as such.
    void runtime.library.loadRemoved();
    runtime.services.library.readingStats(localDay()).then(
      (value) => !cancelled && setStats(value),
      (failure: unknown) => !cancelled && setError(String(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, [runtime.services.library]);
  // Deleted books and online books read without adding them keep their time.
  const books = (stats?.books ?? []).map((record) => ({
    record,
    book: [...library.books, ...library.removedBooks].find(
      (entry) => entry.book.id === record.bookId,
    ),
  }));
  const [gone, setGone] = useState<BookReadingTime | null>(null);
  return (
    <div
      ref={page}
      role="dialog"
      aria-modal="true"
      aria-label="阅读记录"
      data-open=""
      className="fixed inset-0 z-40 bg-surface flex flex-col overflow-hidden pt-safe pb-safe"
    >
      <header className="shrink-0 flex items-center h-14 px-2 gap-1">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={onClose}>
          <Icon name="arrow_back" size={20} />
        </Button>
        <h1 className="font-title-editorial text-base font-semibold">阅读记录</h1>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-5 py-2 space-y-5">
          {error && (
            <p role="alert" className="text-xs text-error break-words">
              {error}
            </p>
          )}
          <dl className="grid grid-cols-2 gap-3">
            {[
              ["今日阅读", stats ? formatDuration(stats.todaySeconds) : "—"],
              ["累计阅读", stats ? formatDuration(stats.totalSeconds) : "—"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-surface-container-low p-4">
                <dt className="text-xs text-secondary">{label}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          {stats && <ActivityMatrix days={stats.days} today={localDay()} />}
          <section aria-labelledby="records-books" className="space-y-2">
            <h2 id="records-books" className="text-xs text-secondary font-medium">
              书籍
            </h2>
            {stats && books.length === 0 && (
              <p className="text-sm text-secondary py-6 text-center">还没有阅读记录。</p>
            )}
            <ul className="space-y-2">
              {books.map(({ record, book }) => (
                <li key={record.bookId}>
                  <button
                    type="button"
                    onClick={() => (book ? onOpenBook(book) : setGone(record))}
                    className={`w-full flex items-center gap-3 rounded-xl bg-surface-container-low p-2.5 text-left hover:bg-surface-container ${
                      book ? "" : "opacity-70"
                    }`}
                  >
                    <span className="w-10 aspect-[3/4] rounded overflow-hidden shrink-0">
                      {book ? <LibraryCover book={book} /> : <BookCover title={record.title} />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">
                        {book?.book.title ?? record.title}
                        {book && book.removedAt !== null && (
                          <span className="ml-2 text-[10px] font-normal text-secondary">
                            回收站
                          </span>
                        )}
                        {!book && (
                          <span className="ml-2 text-[10px] font-normal text-secondary">
                            {record.deleted ? "已删除" : "不在书架"}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-secondary">
                        最近 {record.lastDay} · {formatDuration(record.seconds)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
      {gone && (
        <Dialog open onOpenChange={(open) => !open && setGone(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">{gone.title}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">
              {gone.deleted ? "这本书已删除，无法打开。" : "这本书不在书架上，可以从搜索打开。"}
            </p>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setGone(null)}>
                知道了
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

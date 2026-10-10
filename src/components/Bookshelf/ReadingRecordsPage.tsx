import { useEffect, useState } from "react";
import { useLibrary, useRuntime } from "../../application/runtime";
import type { LibraryBook, ReadingStats } from "../../types/generated";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { usePageLayer } from "../Layout/use-page-layer";
import { BookCover } from "./BookCover";
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
    runtime.services.library.readingStats(localDay()).then(
      (value) => !cancelled && setStats(value),
      (failure: unknown) => !cancelled && setError(String(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, [runtime.services.library]);
  const longest = Math.max(1, ...(stats?.days.map((day) => day.seconds) ?? []));
  const books = (stats?.books ?? [])
    .map((record) => ({
      record,
      book: [...library.books, ...library.removedBooks].find(
        (entry) => entry.book.id === record.bookId,
      ),
    }))
    .filter((item): item is { record: typeof item.record; book: LibraryBook } =>
      Boolean(item.book),
    );
  return (
    <div
      ref={page}
      role="dialog"
      aria-modal="true"
      aria-label="阅读记录"
      data-open=""
      className="fixed inset-0 z-40 bg-surface flex flex-col overflow-hidden pt-safe"
    >
      <header className="shrink-0 flex items-center h-14 px-2 gap-1">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={onClose}>
          <Icon name="arrow_back" size={20} />
        </Button>
        <h1 className="font-title-editorial text-base font-semibold">阅读记录</h1>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto pb-safe">
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
          {stats && stats.days.length > 0 && (
            <section aria-labelledby="records-days" className="space-y-2">
              <h2 id="records-days" className="text-xs text-secondary font-medium">
                最近阅读
              </h2>
              <ul className="space-y-1.5">
                {stats.days.slice(0, 14).map((day) => (
                  <li key={day.day} className="flex items-center gap-3 text-xs">
                    <span className="w-20 shrink-0 tabular-nums text-secondary">
                      {day.day.slice(5)}
                    </span>
                    <span className="flex-1 h-2 rounded-full bg-surface-container overflow-hidden">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${(day.seconds / longest) * 100}%` }}
                      />
                    </span>
                    <span className="w-24 shrink-0 text-right tabular-nums">
                      {formatDuration(day.seconds)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
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
                    onClick={() => onOpenBook(book)}
                    className="w-full flex items-center gap-3 rounded-xl bg-surface-container-low p-2.5 text-left hover:bg-surface-container"
                  >
                    <span className="w-10 aspect-[3/4] rounded overflow-hidden shrink-0">
                      <BookCover title={book.book.title} assetId={book.coverAssetId} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">{book.book.title}</span>
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
    </div>
  );
}

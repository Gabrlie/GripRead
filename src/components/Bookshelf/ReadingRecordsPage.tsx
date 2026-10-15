import { useEffect, useState, type ReactNode } from "react";
import { useLongPress } from "../ui/use-long-press";
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
import { t } from "../../i18n";

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
  const [revision, setRevision] = useState(0);
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
  }, [runtime.services.library, revision]);
  // Deleted books and online books read without adding them keep their time.
  const books = (stats?.books ?? []).map((record) => ({
    record,
    book: [...library.books, ...library.removedBooks].find(
      (entry) => entry.book.id === record.bookId,
    ),
  }));
  const [gone, setGone] = useState<BookReadingTime | null>(null);
  const [removing, setRemoving] = useState<BookReadingTime | null>(null);
  return (
    <div
      ref={page}
      role="dialog"
      aria-modal="true"
      aria-label={t("shelf.menu.records")}
      data-open=""
      className="fixed inset-0 z-40 bg-surface flex flex-col overflow-hidden pt-safe pb-safe"
    >
      <header className="shrink-0 flex items-center h-14 px-2 gap-1">
        <Button variant="ghost" size="icon" aria-label={t("common.back")} onClick={onClose}>
          <Icon name="arrow_back" size={20} />
        </Button>
        <h1 className="font-title-editorial text-base font-semibold">{t("shelf.menu.records")}</h1>
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
              [t("settings.today"), stats ? formatDuration(stats.todaySeconds) : "—"],
              [t("settings.total"), stats ? formatDuration(stats.totalSeconds) : "—"],
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
              {t("records.books")}
            </h2>
            {stats && books.length === 0 && (
              <p className="text-sm text-secondary py-6 text-center">{t("records.none")}</p>
            )}
            <ul className="space-y-2">
              {books.map(({ record, book }) => (
                <li key={record.bookId}>
                  <RecordButton
                    onLongPress={() => setRemoving(record)}
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
                            {t("shelf.menu.bin")}
                          </span>
                        )}
                        {!book && (
                          <span className="ml-2 text-[10px] font-normal text-secondary">
                            {record.deleted ? t("records.deleted") : t("records.offShelf")}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-secondary">
                        {t("records.last", {
                          day: record.lastDay,
                          time: formatDuration(record.seconds),
                        })}
                      </span>
                    </span>
                  </RecordButton>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
      {removing && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("records.delete")}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">
              {t("records.deleteNote", { title: removing.title })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                className="bg-error text-on-error"
                onClick={() => {
                  const target = removing;
                  setRemoving(null);
                  void runtime.services.library.deleteReadingRecord(target.bookId).then(
                    () => setRevision((value) => value + 1),
                    (failure: unknown) => setError(String(failure)),
                  );
                }}
              >
                {t("common.delete")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {gone && (
        <Dialog open onOpenChange={(open) => !open && setGone(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">{gone.title}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">
              {gone.deleted ? t("records.goneDeleted") : t("records.goneOff")}
            </p>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setGone(null)}>
                {t("common.confirm")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function RecordButton({
  onLongPress,
  onClick,
  className,
  children,
}: {
  onLongPress: () => void;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  const press = useLongPress(onLongPress, onClick);
  return (
    <button type="button" {...press} className={className}>
      {children}
    </button>
  );
}

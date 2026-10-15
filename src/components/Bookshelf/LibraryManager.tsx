import { useEffect, useState } from "react";
import { useLibrary, useShelfPreferences } from "../../application/runtime";
import { useApp } from "../../context/AppContext";
import type { ShelfSort } from "../../types/generated";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";
import { t } from "../../i18n";

export function LibraryManager({
  mode,
  onClose,
}: {
  mode: "removed" | "sort" | null;
  onClose: () => void;
}) {
  const { state, store } = useLibrary();
  const preferences = useShelfPreferences();
  const { shelf, setShelf } = useApp();
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (mode === "removed") void store.loadRemoved();
  }, [mode, store]);
  const run = (action: () => Promise<void>) =>
    void action().catch(() => {
      /* The application store owns the visible operation error. */
    });
  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="bg-surface border-surface-variant/50 max-w-sm w-[calc(100%-2rem)] rounded-2xl p-5 space-y-4">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {mode === "sort" ? t("shelf.menu.sort") : t("shelf.menu.bin")}
          </DialogTitle>
          <DialogDescription className="text-xs text-secondary">
            {mode === "sort" ? t("shelf.sort.note") : t("shelf.bin.note")}
          </DialogDescription>
        </DialogHeader>
        {(state.managementError || preferences.state.error) && (
          <div role="alert" className="text-xs text-error">
            {state.managementError || preferences.state.error}
            {preferences.state.error && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  preferences.state.value
                    ? preferences.store.retry()
                    : void preferences.store.load()
                }
              >
                {t("shelf.retrySave")}
              </Button>
            )}
            {mode === "removed" && (
              <Button variant="outline" size="sm" onClick={() => void store.loadRemoved()}>
                {t("shelf.reload")}
              </Button>
            )}
          </div>
        )}
        {mode === "sort" && (
          <div className="space-y-2">
            {(
              [
                ["recent_read", t("shelf.sort.recent")],
                ["imported", t("shelf.sort.imported")],
                ["title", t("detail.bookTitle")],
              ] as const
            ).map(([sort, label]: readonly [ShelfSort, string]) => (
              <Button
                key={sort}
                variant="ghost"
                disabled={!preferences.state.value}
                aria-pressed={shelf.sort === sort}
                onClick={() => setShelf({ sort })}
                className={`w-full text-left justify-between text-xs h-10 rounded-xl ${shelf.sort === sort ? "bg-surface-container text-primary" : "text-secondary"}`}
              >
                {label}
                {shelf.sort === sort && <span aria-hidden="true">✓</span>}
              </Button>
            ))}
          </div>
        )}
        {mode === "removed" && (
          <div className="space-y-2 max-h-80 overflow-auto">
            {(state.removedLoading || !state.removedLoaded) && (
              <p role="status" className="text-xs text-secondary">
                {t("shelf.bin.loading")}
              </p>
            )}
            {state.removedLoaded &&
              !state.removedLoading &&
              state.removedBooks.length === 0 &&
              !state.managementError && (
                <p className="text-xs text-secondary">{t("shelf.bin.empty")}</p>
              )}
            {state.removedBooks.map(({ book }) => (
              <div
                key={book.id}
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-surface-container-low"
              >
                <div className="min-w-0">
                  <p className="font-title-editorial text-sm truncate">{book.title}</p>
                  <p className="text-xs text-secondary truncate">
                    {book.author ?? t("shelf.unknownAuthor")}
                  </p>
                </div>
                <span className="flex gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs"
                    aria-label={t("shelf.bin.restoreBook", { title: book.title })}
                    disabled={state.managing}
                    onClick={() => run(() => store.restore(book.id))}
                  >
                    {t("shelf.bin.restore")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={`text-xs ${confirming === book.id ? "text-on-error bg-error" : "text-error"}`}
                    aria-label={t("shelf.bin.deleteBook", { title: book.title })}
                    disabled={state.managing}
                    onClick={() => {
                      // A second tap confirms; deleting cannot be undone.
                      if (confirming !== book.id) {
                        setConfirming(book.id);
                        return;
                      }
                      setConfirming(null);
                      const entry = state.removedBooks.find((item) => item.book.id === book.id);
                      if (entry) run(() => store.deleteBook(entry, false));
                    }}
                  >
                    {confirming === book.id ? t("shelf.bin.confirm") : t("common.delete")}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

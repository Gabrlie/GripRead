import { useCallback, useEffect, useRef, useState } from "react";
import { useLibrary, useRuntime, useShelf } from "../../application/runtime";
import { hiddenBookIds } from "../../application/shelf";
import type { CloudBook } from "../../types/generated";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { describeError, formatSize, formatTime } from "./format";
import { t } from "../../i18n";

/**
 * The cloud bookshelf: book files in the WebDAV book folder. Local books
 * upload in one step; a cloud book downloads completely and goes through
 * the ordinary import, which matches it to the same file already on the
 * shelf instead of adding a copy. Backups are separate.
 */
export function CloudShelfPage({
  onClose,
  onSetUp,
}: {
  onClose: () => void;
  /** Opens the WebDAV account settings when none is set up. */
  onSetUp?: () => void;
}) {
  const runtime = useRuntime();
  const { state: library } = useLibrary();
  const sync = runtime.services.sync;
  const [listed, setBooks] = useState<CloudBook[] | null>(null);
  // Copies of books in a locked private group are not named here.
  const { state: shelf } = useShelf();
  const hidden = hiddenBookIds(shelf.groups, shelf.unlocked);
  const books =
    listed && listed.filter((book) => !book.localBookId || !hidden.has(book.localBookId));
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CloudBook | null>(null);

  // The local books the cloud list was read against: a book that joined the
  // shelf since (a download being imported) is not counted as 未上传.
  const shelfIds = useRef<string[]>([]);
  shelfIds.current = library.books.map((book) => book.book.id);
  const [listedIds, setListedIds] = useState<Set<string>>(new Set());
  // While the GripRead server is connected, 云书架 lists its books instead.
  const [server, setServer] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const status = await sync.getServer().catch(() => null);
    const connected = Boolean(status?.connected);
    setServer(connected ? status!.address.replace(/^https?:\/\//, "") : null);
    const settings = connected ? { configured: true } : await sync.getWebDav();
    setConfigured(settings.configured);
    if (!settings.configured) return;
    const known = new Set(shelfIds.current);
    setBooks(await sync.listCloudBooks());
    setListedIds(known);
  }, [sync]);
  useEffect(() => {
    setBusy("load");
    refresh()
      .catch((error: unknown) => toast({ text: describeError(error), error: true }))
      .finally(() => setBusy(null));
  }, [refresh]);
  // A book downloaded from here appears on the shelf after its import.
  useEffect(() => {
    if (!library.importing && configured) void refresh().catch(() => undefined);
  }, [library.importing, library.books.length]);

  const run = async (label: string, work: () => Promise<string | void>) => {
    setBusy(label);

    try {
      const text = await work();
      if (text) toast({ text });
    } catch (error) {
      toast({ text: describeError(error), error: true });
    } finally {
      setBusy(null);
    }
  };
  // Online books are not uploaded, so only local books count.
  const localBooks = library.books.filter((book) => !book.online && !hidden.has(book.book.id));
  const localCount = localBooks.length;
  const uploadedLocal = new Set(books?.map((book) => book.localBookId).filter(Boolean));
  const notUploaded = localBooks.filter(
    (book) => listedIds.has(book.book.id) && !uploadedLocal.has(book.book.id),
  ).length;

  return (
    <FullPage
      label={t("shelf.menu.cloud")}
      onClose={onClose}
      layer="z-[45]"
      actions={
        configured && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null || localCount === 0}
            onClick={() =>
              run("upload", async () => {
                const report = await sync.uploadBooks([]);
                await refresh();
                const parts = [t("cloudShelf.uploaded", { count: report.uploaded })];
                if (report.updated) parts.push(t("cloudShelf.updated", { count: report.updated }));
                if (report.skipped) parts.push(t("cloudShelf.skipped", { count: report.skipped }));
                if (report.failed.length)
                  parts.push(
                    t("cloudShelf.failed", {
                      count: report.failed.length,
                      names: report.failed.join("; "),
                    }),
                  );
                return parts.join(t("common.clauseSeparator"));
              })
            }
          >
            <Icon name="cloud" size={15} />
            {busy === "upload" ? t("detail.uploading") : t("cloudShelf.uploadAll")}
          </Button>
        )
      }
    >
      {configured === false && (
        <div className="rounded-xl bg-surface-container-low p-4 space-y-3 text-sm">
          <p>{t("cloudShelf.needsAccount")}</p>
          {onSetUp && (
            <Button size="sm" onClick={onSetUp}>
              {t("cloudShelf.setUp")}
            </Button>
          )}
        </div>
      )}
      {configured && (
        <p className="px-1 text-[11px] text-secondary">
          {server ? (
            <>
              <span className="mr-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                {t("settings.server")}
              </span>
              {t("cloudShelf.onServer", { server })}
            </>
          ) : (
            t("cloudShelf.onWebdav")
          )}
          {books && notUploaded > 0 && t("cloudShelf.notUploaded", { count: notUploaded })}
        </p>
      )}
      {busy === "load" && !books && (
        <p role="status" className="text-sm text-secondary px-1">
          {t("cloudShelf.loading")}
        </p>
      )}
      {books && books.length === 0 && (
        <p className="text-sm text-secondary text-center py-8">{t("cloudShelf.empty")}</p>
      )}
      {books && books.length > 0 && (
        <ul
          aria-label={t("cloudShelf.list")}
          className="rounded-xl bg-surface-container-low divide-y divide-surface-variant/30"
        >
          {books.map((book) => (
            <li key={book.name} className="flex items-center gap-3 px-4 py-3">
              <Icon name="auto_stories" size={18} className="text-secondary shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate">{book.title}</span>
                <span className="block text-[11px] text-secondary truncate">
                  {[book.author, formatSize(book.size), formatTime(book.uploadedAt)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {book.localBookId ? (
                <span className="text-[11px] text-primary shrink-0">{t("cloudShelf.onShelf")}</span>
              ) : book.localRemoved ? (
                <span className="text-[11px] text-secondary shrink-0">{t("cloudShelf.inBin")}</span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || library.importing}
                  onClick={() =>
                    run(`pull:${book.name}`, async () => {
                      const file = await sync.downloadCloudBook(book.name);
                      // The import's own notice reports the book joining the shelf.
                      void runtime.library.importBatch([file.path]);
                    })
                  }
                >
                  {busy === `pull:${book.name}`
                    ? t("cloudShelf.downloading")
                    : t("cloudShelf.download")}
                </Button>
              )}
              {/* A server's books leave it with the shelf (the web version). */}
              {!server && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("cloudShelf.removeOne", { title: book.title })}
                  className="h-8 w-8 text-secondary shrink-0"
                  disabled={busy !== null}
                  onClick={() => setRemoving(book)}
                >
                  <Icon name="delete" size={15} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("detail.removeCloud")}
              </DialogTitle>
              <DialogDescription>
                {t("cloudShelf.removeNote", { title: removing.title })}
              </DialogDescription>
            </DialogHeader>
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
                  void run("delete", async () => {
                    await sync.deleteCloudBook(target.name);
                    await refresh();
                    return t("cloudShelf.removed", { title: target.title });
                  });
                }}
              >
                {t("common.delete")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </FullPage>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useLibrary, useRuntime } from "../../application/runtime";
import type { CloudBook } from "../../types/generated";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { describeError, formatSize, formatTime } from "./format";

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
  const [books, setBooks] = useState<CloudBook[] | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CloudBook | null>(null);

  const refresh = useCallback(async () => {
    const settings = await sync.getWebDav();
    setConfigured(settings.configured);
    if (settings.configured) setBooks(await sync.listCloudBooks());
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
  const localBooks = library.books.filter((book) => !book.online);
  const localCount = localBooks.length;
  const uploadedLocal = new Set(books?.map((book) => book.localBookId).filter(Boolean));
  const notUploaded = localBooks.filter((book) => !uploadedLocal.has(book.book.id)).length;

  return (
    <FullPage
      label="云书架"
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
                const parts = [`上传 ${report.uploaded} 本`];
                if (report.updated) parts.push(`更新信息 ${report.updated} 本`);
                if (report.skipped) parts.push(`${report.skipped} 本已在云书架`);
                if (report.failed.length)
                  parts.push(`${report.failed.length} 本失败：${report.failed.join("；")}`);
                return parts.join("，");
              })
            }
          >
            <Icon name="cloud" size={15} />
            {busy === "upload" ? "正在上传…" : "全部上传"}
          </Button>
        )
      }
    >
      {configured === false && (
        <div className="rounded-xl bg-surface-container-low p-4 space-y-3 text-sm">
          <p>云书架使用 WebDAV 保存书籍文件。请先设置 WebDAV 账号。</p>
          {onSetUp && (
            <Button size="sm" onClick={onSetUp}>
              设置 WebDAV
            </Button>
          )}
        </div>
      )}
      {configured && (
        <p className="px-1 text-[11px] text-secondary">
          书籍保存在 WebDAV 的 GripRead/Books 文件夹。
          {books && notUploaded > 0 && ` 本机还有 ${notUploaded} 本未上传。`}
        </p>
      )}
      {busy === "load" && !books && (
        <p role="status" className="text-sm text-secondary px-1">
          正在读取云书架…
        </p>
      )}
      {books && books.length === 0 && (
        <p className="text-sm text-secondary text-center py-8">云书架还是空的。</p>
      )}
      {books && books.length > 0 && (
        <ul
          aria-label="云端书籍"
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
                <span className="text-[11px] text-primary shrink-0">已在书架</span>
              ) : book.localRemoved ? (
                <span className="text-[11px] text-secondary shrink-0">在回收站</span>
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
                  {busy === `pull:${book.name}` ? "下载中…" : "下载"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`从云书架删除 ${book.title}`}
                className="h-8 w-8 text-secondary shrink-0"
                disabled={busy !== null}
                onClick={() => setRemoving(book)}
              >
                <Icon name="delete" size={15} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">从云书架删除</DialogTitle>
              <DialogDescription>
                删除 WebDAV 上的《{removing.title}》文件。本机书架和备份不受影响。
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                取消
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
                    return `已删除《${target.title}》。`;
                  });
                }}
              >
                删除
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </FullPage>
  );
}

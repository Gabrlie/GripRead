import { useEffect, useState } from "react";
import { useLibrary, useRuntime } from "../../application/runtime";
import type { BookInfo, LibraryBook } from "../../types/generated";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Legado's book information screen for local books: title, author, the
 * introduction found before the first chapter, chapter count, progress, and
 * file size, with reading and editing actions.
 */
export function BookInfoSheet({
  book,
  onOpen,
  onClose,
}: {
  book: LibraryBook;
  onOpen: () => void;
  onClose: () => void;
}) {
  const runtime = useRuntime();
  const { store } = useLibrary();
  const [info, setInfo] = useState<BookInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(book.book.title);
  const [author, setAuthor] = useState(book.book.author ?? "");
  useEffect(() => {
    let cancelled = false;
    runtime.services.library.getBookInfo(book.book.id).then(
      (value) => !cancelled && setInfo(value),
      (failure: unknown) => !cancelled && setError(String(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, [book.book.id, runtime.services.library]);
  const progress =
    book.locator && book.totalLength
      ? `${((book.locator.offset / book.totalLength) * 100).toFixed(1)}%`
      : "未读";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface border border-surface-variant/40 rounded-2xl sm:max-w-md max-h-[86dvh] overflow-y-auto p-5 gap-4">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base pr-6">
            {book.book.title}
          </DialogTitle>
          <DialogDescription>{book.book.author || "作者未知"}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-3 gap-2 text-center">
          {[
            ["章节", info?.chapterCount != null ? `${info.chapterCount} 章` : "—"],
            ["进度", progress],
            ["大小", info ? formatSize(info.sourceByteLength) : "—"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-surface-container-low py-2">
              <dt className="text-[11px] text-secondary">{label}</dt>
              <dd className="text-sm font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <section className="space-y-1.5">
          <h3 className="text-xs text-secondary font-medium">简介</h3>
          {error ? (
            <p role="alert" className="text-xs text-error">
              {error}
            </p>
          ) : (
            <p className="text-sm leading-relaxed whitespace-pre-line text-on-surface/90">
              {info ? info.intro || "这本书没有简介。" : "正在读取…"}
            </p>
          )}
        </section>
        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void store
                .edit({ bookId: book.book.id, title: title.trim(), author: author.trim() || null })
                .then(
                  () => setEditing(false),
                  (failure: unknown) => setError(String(failure)),
                );
            }}
          >
            <label className="block space-y-1 text-xs text-secondary">
              书名
              <Input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="block space-y-1 text-xs text-secondary">
              作者
              <Input value={author} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                取消
              </Button>
              <Button type="submit" size="sm" disabled={!title.trim()}>
                保存
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button className="flex-1" onClick={onOpen}>
              {book.locator ? "继续阅读" : "开始阅读"}
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)}>
              编辑信息
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

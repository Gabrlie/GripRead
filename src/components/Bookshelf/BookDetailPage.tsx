import { useEffect, useState } from "react";
import { useLibrary, useRuntime, useShelf } from "../../application/runtime";
import { READING_GROUPS, shelfGroupOf } from "../../application/shelf";
import type { BookInfo, LibraryBook, ShelfPlacement } from "../../types/generated";
import { ENCODING_NAMES } from "../Reader/dialogs/EncodingDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/Icon";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { BookCover } from "./BookCover";
import { formatDuration } from "../../application/reading-time";
import { usePageLayer } from "../Layout/use-page-layer";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Legado's book information page for local books: the cover, metadata,
 * progress and reading time, the introduction, the shelf group, and every
 * per-book action (read, contents, edit, cover, move, remove).
 */
export function BookDetailPage({
  book,
  onOpen,
  onClose,
}: {
  book: LibraryBook;
  onOpen: (page?: "contents") => void;
  onClose: () => void;
}) {
  const runtime = useRuntime();
  const { store } = useLibrary();
  const { state: shelf, store: shelfStore } = useShelf();
  const [info, setInfo] = useState<BookInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);
  const id = book.book.id;
  useEffect(() => {
    let cancelled = false;
    runtime.services.library.getBookInfo(id).then(
      (value) => !cancelled && setInfo(value),
      (failure: unknown) => !cancelled && setError(String(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, [id, runtime.services.library, revision]);
  const page = usePageLayer(onClose);
  const run = (action: () => Promise<unknown>) =>
    void action().then(
      () => setError(null),
      (failure: unknown) => setError(String(failure)),
    );
  const labels = shelf.chapters[id];
  const automatic = shelf.automatic[id] ?? (book.locator ? "reading" : "unread");
  const current = shelfGroupOf(book, shelf.groups, automatic);
  const manual = book.shelfState !== null || shelf.groups.some((group) => group.id === current);
  const progress =
    book.locator && book.totalLength
      ? `${Math.min(100, (book.locator.offset / book.totalLength) * 100).toFixed(1)}%`
      : "未读";
  const placements: { key: string; label: string; placement: ShelfPlacement }[] = [
    { key: "automatic", label: "自动", placement: { kind: "automatic" } },
    ...READING_GROUPS.slice(1).map((group) => ({
      key: group.id,
      label: group.name,
      placement: { kind: "state", value: group.id } as ShelfPlacement,
    })),
    ...shelf.groups.map((group) => ({
      key: group.id,
      label: group.name,
      placement: { kind: "group", value: group.id } as ShelfPlacement,
    })),
  ];
  const selectedKey = manual ? current : "automatic";
  const rows: [string, string][] = [
    ["作者", book.book.author || "作者未知"],
    ["来源", "本地 TXT"],
    ["文件大小", info ? formatSize(info.sourceByteLength) : "—"],
    ["文本编码", book.txtEncoding ? ENCODING_NAMES[book.txtEncoding.detected] : "—"],
    ["章节", info?.chapterCount != null ? `${info.chapterCount} 章` : "—"],
    ["读至", labels?.current ?? (book.locator ? "全文" : "尚未阅读")],
    ["最新章节", labels?.latest ?? "全文"],
    ["阅读进度", progress],
    ["阅读时长", info ? formatDuration(info.readingSeconds) : "—"],
  ];
  return (
    <div
      ref={page}
      role="dialog"
      aria-modal="true"
      aria-label="书籍详情"
      data-open=""
      className="fixed inset-0 z-40 bg-surface flex flex-col overflow-hidden"
    >
      <header className="relative shrink-0 overflow-hidden pt-safe">
        {/* The cover, blurred, fills the header as in Legado. */}
        <div aria-hidden="true" className="absolute inset-0 scale-125 blur-2xl opacity-60">
          <BookCover title={book.book.title} assetId={book.coverAssetId} />
        </div>
        <div aria-hidden="true" className="absolute inset-0 bg-surface/55" />
        <div className="relative flex items-center h-14 px-2">
          <Button variant="ghost" size="icon" aria-label="返回" onClick={onClose}>
            <Icon name="arrow_back" size={20} />
          </Button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            aria-label="编辑书籍信息"
            onClick={() => setEditing(true)}
          >
            <Icon name="edit" size={20} />
          </Button>
        </div>
        <div className="relative flex gap-4 px-5 pb-5 max-w-2xl mx-auto w-full">
          <div className="w-24 aspect-[3/4] shrink-0 rounded-lg overflow-hidden shadow-md bg-surface-container-high">
            <BookCover title={book.book.title} assetId={book.coverAssetId} />
          </div>
          <div className="min-w-0 flex-1 flex flex-col justify-center gap-1.5">
            <h1 className="font-title-editorial text-lg font-semibold text-on-surface break-words">
              {book.book.title}
            </h1>
            <p className="text-sm text-secondary break-words">{book.book.author || "作者未知"}</p>
            <p className="text-xs text-secondary">
              {progress === "未读" ? "未读" : `已读 ${progress}`}
              {labels?.current && book.locator ? ` · ${labels.current}` : ""}
            </p>
          </div>
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="max-w-2xl mx-auto w-full px-5 py-4 space-y-5 min-w-0">
          {error && (
            <p role="alert" className="text-xs text-error break-words">
              {error}
            </p>
          )}
          <section aria-labelledby="book-intro" className="space-y-1.5 min-w-0">
            <h2 id="book-intro" className="text-xs text-secondary font-medium">
              简介
            </h2>
            <p
              className={`text-sm leading-relaxed whitespace-pre-line break-words [overflow-wrap:anywhere] text-on-surface/90 ${expanded ? "" : "line-clamp-4"}`}
            >
              {info ? info.intro || "这本书没有简介。" : "正在读取…"}
            </p>
            {info?.intro && info.intro.length > 80 && (
              <button
                type="button"
                className="text-xs text-primary"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "收起" : "展开全部"}
              </button>
            )}
          </section>
          <section aria-labelledby="book-group" className="space-y-2">
            <h2 id="book-group" className="text-xs text-secondary font-medium">
              分组
              <span className="ml-2 font-normal">
                {selectedKey === "automatic"
                  ? `自动：${READING_GROUPS.find((group) => group.id === automatic)?.name}`
                  : "已手动移动，直到再次移动"}
              </span>
            </h2>
            <div role="radiogroup" aria-label="书架分组" className="flex flex-wrap gap-2">
              {placements.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="radio"
                  aria-checked={selectedKey === item.key}
                  disabled={shelf.saving}
                  onClick={() => run(() => shelfStore.move(id, item.placement))}
                  className={`h-8 px-3 rounded-full text-xs border transition-colors ${
                    selectedKey === item.key
                      ? "bg-primary text-on-primary border-primary"
                      : "border-surface-variant text-on-surface hover:bg-surface-container"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </section>
          <section aria-labelledby="book-facts">
            <h2 id="book-facts" className="sr-only">
              书籍信息
            </h2>
            <dl className="rounded-2xl bg-surface-container-low divide-y divide-surface-variant/40">
              {rows.map(([label, value]) => (
                <div key={label} className="flex items-center gap-4 px-4 py-2.5 text-sm min-w-0">
                  <dt className="text-secondary shrink-0 w-16">{label}</dt>
                  <dd className="flex-1 min-w-0 text-right truncate tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <Button
            variant="ghost"
            className="w-full text-error"
            onClick={() =>
              run(async () => {
                await store.remove(book);
                onClose();
              })
            }
          >
            <Icon name="delete" size={16} />
            移出书架
          </Button>
        </div>
      </main>
      <footer className="shrink-0 border-t border-surface-variant/40 bg-surface pb-safe">
        <div className="max-w-2xl mx-auto flex gap-3 px-5 py-3">
          <Button variant="outline" className="flex-1" onClick={() => onOpen("contents")}>
            <Icon name="list" size={16} />
            目录
          </Button>
          <Button className="flex-[2]" onClick={() => onOpen()}>
            {book.locator ? "继续阅读" : "开始阅读"}
          </Button>
        </div>
      </footer>
      {editing && (
        <EditBookDialog
          book={book}
          intro={info?.intro ?? ""}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

function EditBookDialog({
  book,
  intro: initialIntro,
  onClose,
  onSaved,
}: {
  book: LibraryBook;
  intro: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const runtime = useRuntime();
  const { store } = useLibrary();
  const [title, setTitle] = useState(book.book.title);
  const [author, setAuthor] = useState(book.book.author ?? "");
  const [intro, setIntro] = useState(initialIntro);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = book.book.id;
  const cover = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action()
      .then(() => store.refresh())
      .then(
        () => setError(null),
        (failure: unknown) => setError(String(failure)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md max-h-[86dvh] overflow-y-auto p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">编辑书籍信息</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3 min-w-0"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void store
              .edit({ bookId: id, title: title.trim(), author: author.trim() || null, intro })
              .then(onSaved, (failure: unknown) => setError(String(failure)))
              .finally(() => setBusy(false));
          }}
        >
          <div className="flex items-center gap-3">
            <div className="w-14 aspect-[3/4] rounded-md overflow-hidden shrink-0">
              <BookCover title={title || book.book.title} assetId={book.coverAssetId} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => cover(() => runtime.services.library.pickBookCover(id))}
              >
                更换封面
              </Button>
              {book.coverAssetId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => cover(() => runtime.services.library.clearBookCover(id))}
                >
                  恢复默认
                </Button>
              )}
            </div>
          </div>
          <label className="block space-y-1 text-xs text-secondary">
            书名
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="block space-y-1 text-xs text-secondary">
            作者
            <Input value={author} onChange={(event) => setAuthor(event.target.value)} />
          </label>
          <label className="block space-y-1 text-xs text-secondary">
            简介
            <textarea
              value={intro}
              rows={6}
              onChange={(event) => setIntro(event.target.value)}
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-ring/50 resize-y"
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-error break-words">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>
              保存
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

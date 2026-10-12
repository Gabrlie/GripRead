import { useEffect, useRef, useState } from "react";
import { useLibrary, useRuntime, useShelf } from "../../application/runtime";
import { READING_GROUPS, shelfGroupOf } from "../../application/shelf";
import type { BookInfo, LibraryBook, ShelfPlacement } from "../../types/generated";
import { ENCODING_NAMES } from "../Reader/dialogs/EncodingDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/Icon";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { BookCover } from "./BookCover";
import { LibraryCover } from "./LibraryCover";
import { updateOnlineToc } from "../../application/online";
import { ChangeSourceDialog } from "../Online/ChangeSourceDialog";
import { SourceDetailsDialog } from "../Online/SourceDetailsDialog";
import { formatDuration } from "../../application/reading-time";
import { usePageLayer } from "../Layout/use-page-layer";
import { describeError } from "../Cloud/format";
import { toast } from "../ui/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const TILE_CLASS =
  "flex flex-col items-center justify-center gap-1 rounded-xl bg-surface-container-low py-2.5 text-xs text-on-surface hover:bg-surface-container disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

function ActionTile({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={TILE_CLASS} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={18} className="text-secondary" />
      <span>{label}</span>
    </button>
  );
}

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
  inReader = false,
  onRemoved,
}: {
  book: LibraryBook;
  /** Opened from the reader: the main button returns to the page. */
  inReader?: boolean;
  onOpen: (page?: "contents") => void;
  onClose: () => void;
  /** After the book leaves the shelf; closes the page by default. */
  onRemoved?: () => void;
}) {
  const runtime = useRuntime();
  const { store } = useLibrary();
  const { state: shelf, store: shelfStore } = useShelf();
  const [info, setInfo] = useState<BookInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "delete-cloud" | null>(null);
  const removed = book.removedAt !== null;
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
  const cloudAction = (work: () => Promise<string>) => {
    setCloudBusy(true);
    work()
      .then(
        (text) => toast(text),
        (failure: unknown) => toast({ text: describeError(failure), error: true }),
      )
      .finally(() => {
        setCloudBusy(false);
        void runtime.library.refresh();
      });
  };
  const [askCloudSync, setAskCloudSync] = useState(false);
  const syncDetails = (announce: boolean) =>
    void runtime.services.sync.uploadBooks([id]).then(
      () => announce && toast("已同步到云书架"),
      (failure: unknown) => toast({ text: describeError(failure), error: true }),
    );
  const uploadToCloud = () =>
    cloudAction(async () => {
      const report = await runtime.services.sync.uploadBooks([id]);
      if (report.failed.length) throw new Error(report.failed.join("；"));
      return report.uploaded
        ? "已上传到云书架"
        : report.updated
          ? "已更新云端信息"
          : "云端信息已是最新";
    });
  const removeFromCloud = () =>
    cloudAction(async () => {
      const cloud = await runtime.services.sync.listCloudBooks();
      const entry = cloud.find((item) => item.localBookId === id);
      if (entry) await runtime.services.sync.deleteCloudBook(entry.name);
      return "已从云书架删除";
    });
  const labels = shelf.chapters[id];
  const automatic = shelf.automatic[id] ?? (book.locator ? "reading" : "unread");
  const current = shelfGroupOf(book, shelf.groups, automatic);
  const manual = book.shelfState !== null || shelf.groups.some((group) => group.id === current);
  const online = book.online;
  const progress = online
    ? book.locator && online.totalChapters
      ? `${Math.min(100, (((online.readChapter ?? 0) + 1) / online.totalChapters) * 100).toFixed(1)}%`
      : "未读"
    : book.locator && book.totalLength
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
  const rows: [string, string][] = online
    ? [
        ["作者", book.book.author || "作者未知"],
        ["来源", online.book.sourceName],
        ["章节", `${online.totalChapters} 章`],
        ["已缓存", `${online.cachedChapters} 章`],
        ["读至", online.readChapterTitle || (book.locator ? "全文" : "尚未阅读")],
        ["最新章节", online.book.latestChapterTitle || "—"],
        ["阅读进度", progress],
        ["阅读时长", info ? formatDuration(info.readingSeconds) : "—"],
      ]
    : [
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
          <LibraryCover book={book} />
        </div>
        <div aria-hidden="true" className="absolute inset-0 bg-surface/55" />
        <div className="relative flex items-center h-14 px-2">
          <Button variant="ghost" size="icon" aria-label="返回" onClick={onClose}>
            <Icon name="arrow_back" size={20} />
          </Button>
          <span className="flex-1" />
        </div>
        <div className="relative flex gap-4 px-5 pb-5 max-w-2xl mx-auto w-full">
          <div className="w-24 aspect-[3/4] shrink-0 rounded-lg overflow-hidden shadow-md bg-surface-container-high">
            <LibraryCover book={book} />
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
          {online && (
            <OnlineActions
              book={book}
              onChanged={() => {
                void runtime.library.refresh();
                setRevision((value) => value + 1);
              }}
              onEdit={() => setEditing(true)}
              onDelete={() => setConfirm("delete")}
            />
          )}
          <div
            role="group"
            aria-label="书籍操作"
            className={`grid grid-cols-3 gap-2 ${online ? "hidden" : ""}`}
          >
            <ActionTile icon="edit" label="编辑" onClick={() => setEditing(true)} />
            {book.inCloud ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="已在云书架"
                  disabled={cloudBusy}
                  className={TILE_CLASS}
                >
                  <Icon name="check" size={18} className="text-primary" />
                  <span>{cloudBusy ? "处理中…" : "已在云书架"}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={uploadToCloud}>
                    <Icon name="refresh" size={15} />
                    更新云端信息
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={removeFromCloud}>
                    <Icon name="delete" size={15} />
                    从云书架删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <ActionTile
                icon="cloud"
                label={cloudBusy ? "正在上传…" : "上传到云书架"}
                disabled={cloudBusy}
                onClick={uploadToCloud}
              />
            )}
            {removed ? (
              <ActionTile
                icon="restart"
                label="移回书架"
                onClick={() => run(() => store.restore(id))}
              />
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger aria-label="移出书架" className={TILE_CLASS}>
                  <Icon name="delete" size={18} className="text-secondary" />
                  <span>移出书架</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    onClick={() =>
                      run(async () => {
                        await store.remove(book);
                        (onRemoved ?? onClose)();
                      })
                    }
                  >
                    <Icon name="delete" size={15} />
                    移到回收站
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConfirm("delete")}>
                    <Icon name="close" size={15} />
                    删除（保留云端文件）
                  </DropdownMenuItem>
                  {book.inCloud && (
                    <DropdownMenuItem onClick={() => setConfirm("delete-cloud")}>
                      <Icon name="close" size={15} />
                      本地与云端一起删除
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {removed && (
            <p className="text-xs text-secondary">这本书在回收站里，移回书架后继续阅读。</p>
          )}
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
        </div>
      </main>
      <footer className="shrink-0 border-t border-surface-variant/40 bg-surface pb-safe">
        <div className="max-w-2xl mx-auto flex gap-3 px-5 py-3">
          <Button
            variant="outline"
            className="flex-1"
            disabled={removed}
            onClick={() => onOpen("contents")}
          >
            <Icon name="list" size={16} />
            目录
          </Button>
          <Button className="flex-[2]" disabled={removed} onClick={() => onOpen()}>
            {inReader ? "返回阅读" : book.locator ? "继续阅读" : "开始阅读"}
          </Button>
        </div>
      </footer>
      {confirm && (
        <Dialog open onOpenChange={(open) => !open && setConfirm(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {online || confirm === "delete" ? "删除这本书" : "本地与云端一起删除"}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">
              {online
                ? `从书架删除《${book.book.title}》和它缓存的章节。`
                : confirm === "delete"
                  ? `删除《${book.book.title}》，云书架上的文件保留。`
                  : `删除《${book.book.title}》和云书架上的文件。`}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                取消
              </Button>
              <Button
                size="sm"
                className="bg-error text-on-error"
                onClick={() => {
                  const cloud = confirm === "delete-cloud";
                  setConfirm(null);
                  run(async () => {
                    await store.deleteBook(book, cloud);
                    (onRemoved ?? onClose)();
                  });
                }}
              >
                删除
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {askCloudSync && (
        <Dialog open onOpenChange={(open) => !open && setAskCloudSync(false)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">同步到云书架？</DialogTitle>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAskCloudSync(false)}>
                不用
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setAskCloudSync(false);
                  syncDetails(true);
                }}
              >
                同步
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {editing && (
        <EditBookDialog
          book={book}
          intro={info?.intro ?? ""}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setRevision((value) => value + 1);
            // A book on the cloud bookshelf can take the new details there too.
            if (!book.inCloud) return;
            void runtime.services.sync.getWebDav().then(
              (settings) =>
                settings.autoSyncBookInfo ? syncDetails(false) : setAskCloudSync(true),
              () => undefined,
            );
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
  const [choosing, setChoosing] = useState(false);
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
              <LibraryCover book={book} title={title || book.book.title} />
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setChoosing(true)}
              >
                从书源选择封面
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
          {choosing && (
            <SourceDetailsDialog
              service={runtime.services.sources}
              title={title.trim() || book.book.title}
              author={author.trim()}
              onCover={(found) =>
                runtime.services.sources
                  .setCoverFromSource(id, found.sourceUrl, found.coverUrl)
                  .then(() => store.refresh())
              }
              onClose={() => setChoosing(false)}
            />
          )}
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

/**
 * An online book's actions in Legado's detail page: 更新目录, 离线缓存
 * (the next 50 chapters, the rest, or clearing them), 允许更新, and 删除.
 */
function OnlineActions({
  book,
  onChanged,
  onEdit,
  onDelete,
}: {
  book: LibraryBook;
  onChanged: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const runtime = useRuntime();
  const service = runtime.services.sources;
  const online = book.online!;
  const id = book.book.id;
  const [updating, setUpdating] = useState(false);
  const [caching, setCaching] = useState<{ operationId: string; text: string } | null>(null);
  const [changing, setChanging] = useState(false);
  const operation = useRef<string | null>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    void service
      .onCache((event) => {
        if (event.operationId !== operation.current) return;
        if (event.done) {
          operation.current = null;
          setCaching(null);
          toast(`已缓存 ${event.cached} 章${event.failed ? `，${event.failed} 章失败` : ""}`);
          onChanged();
          return;
        }
        setCaching({
          operationId: event.operationId,
          text: `缓存中 ${event.cached + event.failed}/${event.total}`,
        });
      })
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      });
    return () => {
      active = false;
      stop?.();
      if (operation.current) void service.cancel(operation.current);
    };
  }, [service]);

  const cache = (count: number | null) => {
    const start = online.readChapter ?? 0;
    const end = count === null ? online.totalChapters : start + count;
    const operationId = `cache-${Date.now()}`;
    operation.current = operationId;
    setCaching({ operationId, text: "准备缓存" });
    void service
      .cacheChapters({ operationId, bookId: id, start, end })
      .catch((failure: unknown) => {
        operation.current = null;
        setCaching(null);
        toast({ text: String(failure), error: true });
      });
  };

  return (
    <div role="group" aria-label="书籍操作" className="grid grid-cols-3 gap-2">
      <ActionTile icon="edit" label="编辑" onClick={onEdit} />
      <ActionTile icon="swap_horiz" label="换源" onClick={() => setChanging(true)} />
      {changing && (
        <ChangeSourceDialog
          service={service}
          book={book}
          onChanged={() => {
            setChanging(false);
            runtime.positions.forget(id);
            onChanged();
          }}
          onClose={() => setChanging(false)}
        />
      )}
      <ActionTile
        icon="refresh"
        label={updating ? "更新中…" : "更新目录"}
        disabled={updating}
        onClick={() => {
          setUpdating(true);
          void updateOnlineToc(service, [id])
            .then(([outcome]) =>
              toast(
                outcome?.error
                  ? { text: `目录更新失败：${outcome.error}`, error: true }
                  : `目录已更新${outcome?.newChapters ? `，${outcome.newChapters} 个新章节` : ""}`,
              ),
            )
            .catch((failure: unknown) => toast({ text: String(failure), error: true }))
            .finally(() => {
              setUpdating(false);
              onChanged();
            });
        }}
      />
      {caching ? (
        <ActionTile
          icon="close"
          label={caching.text}
          onClick={() => void service.cancel(caching.operationId)}
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="离线缓存" className={TILE_CLASS}>
            <Icon name="download" size={18} className="text-secondary" />
            <span>缓存</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => cache(50)}>
              <Icon name="download" size={15} />
              缓存后面 50 章
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => cache(null)}>
              <Icon name="download" size={15} />
              缓存后面全部
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void service.clearOnlineCache(id).then(() => {
                  toast("已清除缓存");
                  onChanged();
                })
              }
            >
              <Icon name="delete" size={15} />
              清除缓存
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ActionTile
        icon={online.canUpdate ? "check_box" : "check_box_outline"}
        label="允许更新"
        onClick={() => void service.setCanUpdate(id, !online.canUpdate).then(onChanged)}
      />
      <ActionTile icon="delete" label="删除" onClick={onDelete} />
    </div>
  );
}

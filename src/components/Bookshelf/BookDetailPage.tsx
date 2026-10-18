import { useEffect, useRef, useState } from "react";
import { useLibrary, useRuntime, useShelf } from "../../application/runtime";
import { TocSuggestionPrompt } from "../Reader/TocSuggestionPrompt";
import { READING_GROUPS, shelfGroupOf } from "../../application/shelf";
import type { BookInfo, DownloadJob, LibraryBook, ShelfPlacement } from "../../types/generated";
import { ENCODING_NAMES } from "../Reader/dialogs/EncodingDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/Icon";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { BookCover } from "./BookCover";
import { LibraryCover } from "./LibraryCover";
import { ComicMark } from "../ui/ComicMark";
import { isComic } from "../../application/comic";
import { updateOnlineToc } from "../../application/online";
import { ChangeSourceDialog } from "../Online/ChangeSourceDialog";
import { CacheRangeDialog } from "../Online/CacheRangeDialog";
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
import { currentLocale, t } from "../../i18n";
import { introLabel, useIntroTranslation } from "../Online/use-title-translation";
import { TranslatedMark } from "../Online/TitleTranslationChip";

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
/** 总字数 as readers know it: 万字 above ten thousand, or thousands in English. */
export function formatWords(count: number): string {
  if (currentLocale() === "en")
    return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k characters` : `${count} characters`;
  return count >= 10_000 ? `${(count / 10_000).toFixed(1)} 万字` : `${count} 字`;
}

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
  const intro = useIntroTranslation(info?.intro);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);
  const id = book.book.id;
  useEffect(() => {
    let cancelled = false;
    runtime.services.library.getBookInfo(id).then(
      (value) => !cancelled && setInfo(value),
      (failure: unknown) => !cancelled && setError(describeError(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, [id, runtime.services.library, revision]);
  const page = usePageLayer(onClose);
  const run = (action: () => Promise<unknown>) =>
    void action().then(
      () => setError(null),
      (failure: unknown) => setError(describeError(failure)),
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
      () => announce && toast(t("detail.cloudSynced")),
      (failure: unknown) => toast({ text: describeError(failure), error: true }),
    );
  const uploadToCloud = () =>
    cloudAction(async () => {
      const report = await runtime.services.sync.uploadBooks([id]);
      if (report.failed.length) throw new Error(report.failed.join("；"));
      return report.uploaded
        ? t("shelf.inCloud")
        : report.updated
          ? t("detail.cloudUpdated")
          : t("detail.cloudCurrent");
    });
  const removeFromCloud = () =>
    cloudAction(async () => {
      const cloud = await runtime.services.sync.listCloudBooks();
      const entry = cloud.find((item) => item.localBookId === id);
      if (entry) await runtime.services.sync.deleteCloudBook(entry.name);
      return t("detail.cloudRemoved");
    });
  const labels = shelf.chapters[id];
  const automatic = shelf.automatic[id] ?? (book.locator ? "reading" : "unread");
  const current = shelfGroupOf(book, shelf.groups, automatic);
  const manual = book.shelfState !== null || shelf.groups.some((group) => group.id === current);
  const online = book.online;
  const progress = online
    ? book.locator && online.totalChapters
      ? `${Math.min(100, (((online.readChapter ?? 0) + 1) / online.totalChapters) * 100).toFixed(1)}%`
      : t("detail.unread")
    : book.locator && book.totalLength
      ? `${Math.min(100, (book.locator.offset / book.totalLength) * 100).toFixed(1)}%`
      : t("detail.unread");
  const placements: { key: string; label: string; placement: ShelfPlacement }[] = [
    { key: "automatic", label: t("detail.automatic"), placement: { kind: "automatic" } },
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
        [t("detail.author"), book.book.author || t("shelf.unknownAuthor")],
        [t("detail.source"), online.book.sourceName],
        [t("detail.chapterCount"), t("detail.chapters", { count: online.totalChapters })],
        [
          t("detail.cached"),
          `${t("detail.chapters", { count: online.cachedChapters })}${info?.wordCount ? ` · ${formatWords(info.wordCount)}` : ""}`,
        ],
        [
          t("detail.readTo"),
          online.readChapterTitle || (book.locator ? t("shelf.wholeText") : t("shelf.notRead")),
        ],
        [t("detail.latest"), online.book.latestChapterTitle || "—"],
        [t("detail.progress"), progress],
        [t("detail.readingTime"), info ? formatDuration(info.readingSeconds) : "—"],
      ]
    : [
        [t("detail.author"), book.book.author || t("shelf.unknownAuthor")],
        [
          t("detail.source"),
          book.asset?.kind === "epub" ? t("detail.localEpub") : t("detail.localTxt"),
        ],
        [t("detail.fileSize"), info ? formatSize(info.sourceByteLength) : "—"],
        [
          t("detail.encoding"),
          book.asset?.kind === "epub"
            ? "—"
            : book.txtEncoding
              ? ENCODING_NAMES[book.txtEncoding.detected]
              : "—",
        ],
        [
          t("detail.chapterCount"),
          info?.chapterCount != null ? t("detail.chapters", { count: info.chapterCount }) : "—",
        ],
        [t("detail.words"), info?.wordCount != null ? formatWords(info.wordCount) : "—"],
        [
          t("detail.readTo"),
          labels?.current ?? (book.locator ? t("shelf.wholeText") : t("shelf.notRead")),
        ],
        [t("detail.latest"), labels?.latest ?? t("shelf.wholeText")],
        [t("detail.progress"), progress],
        [t("detail.readingTime"), info ? formatDuration(info.readingSeconds) : "—"],
      ];
  return (
    <div
      ref={page}
      role="dialog"
      aria-modal="true"
      aria-label={t("detail.title")}
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
          <Button variant="ghost" size="icon" aria-label={t("common.back")} onClick={onClose}>
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
              {isComic(book) && (
                <span className="ml-2 align-middle">
                  <ComicMark />
                </span>
              )}
            </h1>
            <p className="text-sm text-secondary break-words">
              {book.book.author || t("shelf.unknownAuthor")}
            </p>
            <p className="text-xs text-secondary">
              {progress === t("detail.unread")
                ? t("detail.unread")
                : t("detail.readPercent", { progress })}
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
              onConverted={
                inReader
                  ? undefined
                  : () => {
                      void runtime.library.refresh();
                      (onRemoved ?? onClose)();
                    }
              }
            />
          )}
          <div
            role="group"
            aria-label={t("detail.actions")}
            className={`grid grid-cols-3 gap-2 ${online ? "hidden" : ""}`}
          >
            <ActionTile icon="edit" label={t("common.edit")} onClick={() => setEditing(true)} />
            {book.inCloud ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t("detail.inCloud")}
                  disabled={cloudBusy}
                  className={TILE_CLASS}
                >
                  <Icon name="check" size={18} className="text-primary" />
                  <span>{cloudBusy ? t("detail.working") : t("detail.inCloud")}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={uploadToCloud}>
                    <Icon name="refresh" size={15} />
                    {t("detail.updateCloud")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={removeFromCloud}>
                    <Icon name="delete" size={15} />
                    {t("detail.removeCloud")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <ActionTile
                icon="cloud"
                label={cloudBusy ? t("detail.uploading") : t("detail.upload")}
                disabled={cloudBusy}
                onClick={uploadToCloud}
              />
            )}
            {removed ? (
              <ActionTile
                icon="restart"
                label={t("detail.restore")}
                onClick={() => run(() => store.restore(id))}
              />
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger aria-label={t("detail.remove")} className={TILE_CLASS}>
                  <Icon name="delete" size={18} className="text-secondary" />
                  <span>{t("detail.remove")}</span>
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
                    {t("detail.toBin")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConfirm("delete")}>
                    <Icon name="close" size={15} />
                    {t("detail.deleteKeepCloud")}
                  </DropdownMenuItem>
                  {book.inCloud && (
                    <DropdownMenuItem onClick={() => setConfirm("delete-cloud")}>
                      <Icon name="close" size={15} />
                      {t("detail.deleteBoth")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {removed && <p className="text-xs text-secondary">{t("detail.inBin")}</p>}
          {error && (
            <p role="alert" className="text-xs text-error break-words">
              {error}
            </p>
          )}
          <section aria-labelledby="book-intro" className="space-y-1.5 min-w-0">
            <div className="flex items-center justify-between">
              <h2
                id="book-intro"
                className="text-xs text-secondary font-medium flex items-center gap-1.5"
              >
                {t("detail.intro")}
                {intro.on && <TranslatedMark />}
              </h2>
              {intro.available && (
                <button
                  type="button"
                  className="text-xs text-primary disabled:opacity-60"
                  disabled={intro.busy}
                  onClick={intro.toggle}
                >
                  {introLabel(intro)}
                </button>
              )}
            </div>
            <p
              data-selectable="true"
              className={`text-sm leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-on-surface/90 ${expanded ? "" : "line-clamp-4"}`}
            >
              {info ? intro.text || t("detail.noIntro") : t("common.loading")}
            </p>
            {info?.intro && info.intro.length > 80 && (
              <button
                type="button"
                className="text-xs text-primary"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t("detail.collapse") : t("detail.expand")}
              </button>
            )}
          </section>
          <section aria-labelledby="book-group" className="space-y-2">
            <h2 id="book-group" className="text-xs text-secondary font-medium">
              {t("detail.group")}
              <span className="ml-2 font-normal">
                {selectedKey === "automatic"
                  ? t("detail.automaticGroup", {
                      group: READING_GROUPS.find((group) => group.id === automatic)?.name ?? "",
                    })
                  : t("detail.manualGroup")}
              </span>
            </h2>
            <div role="radiogroup" aria-label={t("shelf.groups")} className="flex flex-wrap gap-2">
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
              {t("detail.info")}
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
            {t("detail.contents")}
          </Button>
          <Button className="flex-[2]" disabled={removed} onClick={() => onOpen()}>
            {inReader
              ? t("detail.backToReading")
              : book.locator
                ? t("detail.continue")
                : t("detail.start")}
          </Button>
        </div>
      </footer>
      {confirm && (
        <Dialog open onOpenChange={(open) => !open && setConfirm(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {online || confirm === "delete" ? t("detail.deleteBook") : t("detail.deleteBoth")}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">
              {online
                ? t("detail.deleteOnline", { title: book.book.title })
                : confirm === "delete"
                  ? t("detail.deleteLocal", { title: book.book.title })
                  : t("detail.deleteEverywhere", { title: book.book.title })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                {t("common.cancel")}
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
                {t("common.delete")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {askCloudSync && (
        <Dialog open onOpenChange={(open) => !open && setAskCloudSync(false)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("detail.askSync")}
              </DialogTitle>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAskCloudSync(false)}>
                {t("detail.no")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setAskCloudSync(false);
                  syncDetails(true);
                }}
              >
                {t("detail.sync")}
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
      {!removed && !inReader && <TocSuggestionPrompt bookId={id} />}
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
        (failure: unknown) => setError(describeError(failure)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md max-h-[86dvh] overflow-y-auto p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">{t("detail.edit")}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3 min-w-0"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void store
              .edit({ bookId: id, title: title.trim(), author: author.trim() || null, intro })
              .then(onSaved, (failure: unknown) => setError(describeError(failure)))
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
                {t("detail.changeCover")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setChoosing(true)}
              >
                {t("detail.sourceCover")}
              </Button>
              {book.coverAssetId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => cover(() => runtime.services.library.clearBookCover(id))}
                >
                  {t("detail.resetCover")}
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
            {t("detail.bookTitle")}
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="block space-y-1 text-xs text-secondary">
            {t("detail.author")}
            <Input value={author} onChange={(event) => setAuthor(event.target.value)} />
          </label>
          <label className="block space-y-1 text-xs text-secondary">
            {t("detail.intro")}
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
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>
              {t("common.save")}
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
  onConverted,
}: {
  book: LibraryBook;
  onChanged: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** After 转为本地书籍; not offered inside the reader. */
  onConverted?: () => void;
}) {
  const runtime = useRuntime();
  const service = runtime.services.sources;
  const online = book.online!;
  const id = book.book.id;
  const [updating, setUpdating] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [converting, setConverting] = useState<"ask" | "busy" | null>(null);
  const complete = online.totalChapters > 0 && online.cachedChapters >= online.totalChapters;
  // This book's job in 下载管理, which keeps running after the page closes.
  const [job, setJob] = useState<DownloadJob | null>(null);
  const downloading = useRef(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    const take = (jobs: DownloadJob[]) => {
      if (!active) return;
      const mine = jobs.find(
        (item) => item.bookId === id && (item.state === "running" || item.state === "queued"),
      );
      // A download that just ended changed the cached count.
      if (!mine && downloading.current) onChanged();
      downloading.current = Boolean(mine);
      setJob(mine ?? null);
    };
    void service.listDownloads().then(take, () => undefined);
    void service.onDownloads(take).then((unsubscribe) => {
      if (active) stop = unsubscribe;
      else unsubscribe();
    });
    return () => {
      active = false;
      stop?.();
    };
    // The first onChanged is enough: it only asks the page to reload.
  }, [service, id]);

  return (
    <div role="group" aria-label={t("detail.actions")} className="grid grid-cols-3 gap-2">
      <ActionTile icon="edit" label={t("common.edit")} onClick={onEdit} />
      <ActionTile
        icon="swap_horiz"
        label={t("detail.changeSource")}
        onClick={() => setChanging(true)}
      />
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
        label={updating ? t("detail.updating") : t("shelf.menu.update")}
        disabled={updating}
        onClick={() => {
          setUpdating(true);
          void updateOnlineToc(service, [id])
            .then(([outcome]) =>
              toast(
                outcome?.error
                  ? { text: t("detail.updateFailed", { error: outcome.error }), error: true }
                  : outcome?.newChapters
                    ? t("shelf.updated", { added: outcome.newChapters })
                    : t("detail.updated"),
              ),
            )
            .catch((failure: unknown) => toast({ text: describeError(failure), error: true }))
            .finally(() => {
              setUpdating(false);
              onChanged();
            });
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={t("detail.offline")} className={TILE_CLASS}>
          <Icon name="download" size={18} className="text-secondary" />
          <span>
            {job
              ? job.state === "queued"
                ? t("detail.cacheQueued")
                : t("detail.caching", { done: job.cached + job.failed, total: job.total })
              : t("detail.cache")}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => setChoosing(true)}>
            <Icon name="download" size={15} />
            {t("detail.chooseCache")}
          </DropdownMenuItem>
          {job && (
            <DropdownMenuItem onClick={() => void service.pauseDownload(job.id)}>
              <Icon name="close" size={15} />
              {t("detail.pauseCache")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() =>
              void service.clearOnlineCache(id).then(() => {
                toast(t("detail.cacheCleared"));
                onChanged();
              })
            }
          >
            <Icon name="delete" size={15} />
            {t("detail.clearCache")}
          </DropdownMenuItem>
          {/* A comic's pages are pictures: it stays online. */}
          {complete && onConverted && !book.online?.book.comic && (
            <DropdownMenuItem onClick={() => setConverting("ask")}>
              <Icon name="collections_bookmark" size={15} />
              {t("detail.toLocal")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {choosing && <CacheRangeDialog book={book} onClose={() => setChoosing(false)} />}
      {converting && (
        <Dialog open onOpenChange={(open) => !open && converting === "ask" && setConverting(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("detail.toLocal")}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">{t("detail.toLocal.note")}</p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={converting === "busy"}
                onClick={() => setConverting(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={converting === "busy"}
                onClick={() => {
                  setConverting("busy");
                  void service.convertToLocal(id).then(
                    () => {
                      toast(t("detail.converted"));
                      setConverting(null);
                      onConverted?.();
                    },
                    (failure: unknown) => {
                      setConverting(null);
                      toast({ text: describeError(failure), error: true });
                    },
                  );
                }}
              >
                {converting === "busy" ? t("detail.converting") : t("detail.convert")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      <ActionTile
        icon={online.canUpdate ? "check_box" : "check_box_outline"}
        label={t("detail.allowUpdates")}
        onClick={() => void service.setCanUpdate(id, !online.canUpdate).then(onChanged)}
      />
      <ActionTile icon="delete" label={t("common.delete")} onClick={onDelete} />
    </div>
  );
}

import { useEffect, useState } from "react";
import { useLibrary, useRuntime } from "../../application/runtime";
import type { DownloadJob, LibraryBook } from "../../types/generated";
import { FullPage, PageSection } from "../Layout/FullPage";
import { presetRange } from "../Online/CacheRangeDialog";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { t } from "../../i18n";

const states = (): Record<DownloadJob["state"], string> => ({
  queued: t("downloads.queued"),
  running: t("downloads.running"),
  paused: t("downloads.paused"),
  done: t("downloads.done"),
  cancelled: t("downloads.cancelled"),
});

/**
 * 下载管理: the download queue, which keeps running in the background
 * after this page closes, and 离线缓存 for choosing shelf books to add.
 */
export function DownloadManagerPage({ onClose }: { onClose: () => void }) {
  const runtime = useRuntime();
  const service = runtime.services.sources;
  const { state } = useLibrary();
  const books = state.books.filter(
    (book): book is LibraryBook & { online: NonNullable<LibraryBook["online"]> } =>
      Boolean(book.online?.onShelf),
  );
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    void service.listDownloads().then(
      (list) => active && setJobs(list),
      () => undefined,
    );
    void service
      .onDownloads((list) => active && setJobs(list))
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [service]);

  const add = (preset: "next50" | "rest" | "all") => {
    const chosen = books.filter((book) => selected.has(book.book.id));
    setSelected(new Set());
    setAdding(false);
    void Promise.allSettled(
      chosen.map((book) => {
        const range = presetRange(book, preset);
        return service.enqueueDownload(book.book.id, range.start, range.end);
      }),
    ).then((results) => {
      const failed = results.filter((result) => result.status === "rejected").length;
      toast(failed ? t("downloads.addedSome", { failed }) : t("downloads.added"));
    });
  };

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const active = jobs.some((job) => job.state === "running" || job.state === "queued");
  const finished = jobs.some((job) => job.state === "done" || job.state === "cancelled");

  return (
    <FullPage
      label={t("shelf.menu.downloads")}
      onClose={onClose}
      actions={
        <Button variant="ghost" size="sm" onClick={() => setAdding((value) => !value)}>
          {adding ? t("common.done") : t("downloads.add")}
        </Button>
      }
    >
      {adding ? (
        books.length === 0 ? (
          <p className="py-10 text-center text-sm text-secondary">{t("downloads.noBooks")}</p>
        ) : (
          <>
            <ul aria-label={t("downloads.books")} className="space-y-1.5">
              {books.map((book) => {
                const on = selected.has(book.book.id);
                return (
                  <li key={book.book.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={book.book.title}
                      onClick={() => toggle(book.book.id)}
                      className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left ${
                        on ? "bg-primary/10" : "bg-surface-container-low"
                      }`}
                    >
                      <Icon
                        name={on ? "check_box" : "check_box_outline"}
                        size={18}
                        className="text-primary shrink-0"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm truncate">{book.book.title}</span>
                        <span className="block text-[11px] text-secondary">
                          {t("downloads.cachedOf", {
                            cached: book.online.cachedChapters,
                            total: book.online.totalChapters,
                          })}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="sticky bottom-0 -mx-3 px-3 pt-2 pb-3 bg-surface grid grid-cols-4 gap-2">
              <Button
                variant="outline"
                onClick={() => setSelected(new Set(books.map((book) => book.book.id)))}
              >
                {t("downloads.selectAll")}
              </Button>
              <Button disabled={!selected.size} onClick={() => add("next50")}>
                {t("downloads.next50")}
              </Button>
              <Button disabled={!selected.size} onClick={() => add("rest")}>
                {t("downloads.allAfter")}
              </Button>
              <Button disabled={!selected.size} onClick={() => add("all")}>
                {t("downloads.all")}
              </Button>
            </div>
          </>
        )
      ) : jobs.length === 0 ? (
        <p className="py-10 text-center text-sm text-secondary">{t("downloads.none")}</p>
      ) : (
        <PageSection>
          <ul aria-label={t("downloads.jobs")}>
            {jobs.map((job) => {
              const done = job.cached + job.failed;
              const running = job.state === "running" || job.state === "queued";
              return (
                <li key={job.id} className="px-4 py-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 text-sm truncate">{job.title}</span>
                    {running ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        onClick={() => void service.pauseDownload(job.id)}
                      >
                        {t("downloads.pause")}
                      </Button>
                    ) : (
                      (job.state === "paused" || job.state === "cancelled") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => void service.resumeDownload(job.id)}
                        >
                          {t("downloads.resume")}
                        </Button>
                      )
                    )}
                    {job.state !== "done" && job.state !== "cancelled" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        aria-label={t("downloads.cancelJob", { title: job.title })}
                        onClick={() => void service.cancelDownload(job.id)}
                      >
                        {t("common.cancel")}
                      </Button>
                    )}
                  </div>
                  <div
                    role="progressbar"
                    aria-label={t("downloads.progress", { title: job.title })}
                    aria-valuemin={0}
                    aria-valuemax={job.total}
                    aria-valuenow={done}
                    className="h-1.5 rounded-full bg-surface-container-highest overflow-hidden"
                  >
                    <div
                      className="h-full bg-primary transition-[width]"
                      style={{ width: `${job.total ? (done / job.total) * 100 : 0}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-secondary tabular-nums">
                    {t("downloads.jobLine", {
                      state: states()[job.state],
                      from: job.start + 1,
                      to: job.end,
                      cached: job.cached,
                      total: job.total,
                    })}
                    {job.failed ? t("downloads.jobFailed", { failed: job.failed }) : ""}
                  </p>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end gap-2 px-4 pb-3">
            {active && (
              <Button size="sm" variant="ghost" onClick={() => void service.pauseAllDownloads()}>
                {t("downloads.pauseAll")}
              </Button>
            )}
            {finished && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void service.clearFinishedDownloads()}
              >
                {t("downloads.clearDone")}
              </Button>
            )}
          </div>
        </PageSection>
      )}
    </FullPage>
  );
}

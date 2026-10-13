import { useEffect, useState } from "react";
import { useLibrary, useRuntime } from "../../application/runtime";
import type { DownloadJob, LibraryBook } from "../../types/generated";
import { FullPage, PageSection } from "../Layout/FullPage";
import { presetRange } from "../Online/CacheRangeDialog";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";

const STATES: Record<DownloadJob["state"], string> = {
  queued: "等待中",
  running: "缓存中",
  paused: "已暂停",
  done: "已完成",
  cancelled: "已取消",
};

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
      toast(failed ? `已加入下载，${failed} 本没有要缓存的章节` : "已加入下载");
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
      label="下载管理"
      onClose={onClose}
      actions={
        <Button variant="ghost" size="sm" onClick={() => setAdding((value) => !value)}>
          {adding ? "完成" : "添加"}
        </Button>
      }
    >
      {adding ? (
        books.length === 0 ? (
          <p className="py-10 text-center text-sm text-secondary">书架上没有网络书籍。</p>
        ) : (
          <>
            <ul aria-label="网络书籍" className="space-y-1.5">
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
                          已缓存 {book.online.cachedChapters}/{book.online.totalChapters} 章
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
                全选
              </Button>
              <Button disabled={!selected.size} onClick={() => add("next50")}>
                后面 50 章
              </Button>
              <Button disabled={!selected.size} onClick={() => add("rest")}>
                后面全部
              </Button>
              <Button disabled={!selected.size} onClick={() => add("all")}>
                全部
              </Button>
            </div>
          </>
        )
      ) : jobs.length === 0 ? (
        <p className="py-10 text-center text-sm text-secondary">
          没有下载任务。点右上角的添加，或在书籍详情和阅读菜单里选择缓存。
        </p>
      ) : (
        <PageSection>
          <ul aria-label="下载任务">
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
                        暂停
                      </Button>
                    ) : (
                      (job.state === "paused" || job.state === "cancelled") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => void service.resumeDownload(job.id)}
                        >
                          继续
                        </Button>
                      )
                    )}
                    {job.state !== "done" && job.state !== "cancelled" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        aria-label={`取消《${job.title}》`}
                        onClick={() => void service.cancelDownload(job.id)}
                      >
                        取消
                      </Button>
                    )}
                  </div>
                  <div
                    role="progressbar"
                    aria-label={`《${job.title}》的进度`}
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
                    {STATES[job.state]} · 第 {job.start + 1}–{job.end} 章 · {job.cached}/{job.total}
                    {job.failed ? ` · 失败 ${job.failed}` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end gap-2 px-4 pb-3">
            {active && (
              <Button size="sm" variant="ghost" onClick={() => void service.pauseAllDownloads()}>
                全部暂停
              </Button>
            )}
            {finished && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void service.clearFinishedDownloads()}
              >
                清除已完成
              </Button>
            )}
          </div>
        </PageSection>
      )}
    </FullPage>
  );
}

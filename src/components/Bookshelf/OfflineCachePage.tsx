import { useEffect, useRef, useState } from "react";
import { useLibrary, useRuntime } from "../../application/runtime";
import type { LibraryBook } from "../../types/generated";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";

/** Books downloading at once. */
const PARALLEL = 2;

interface Job {
  bookId: string;
  start: number;
  end: number;
}

interface Progress {
  operationId: string | null;
  cached: number;
  failed: number;
  total: number;
  state: "queued" | "running" | "done";
}

/**
 * Legado's 离线缓存: the online books on the shelf with how much of each is
 * kept; chosen books download their next 50 chapters or the rest, two
 * books at a time.
 */
export function OfflineCachePage({ onClose }: { onClose: () => void }) {
  const runtime = useRuntime();
  const service = runtime.services.sources;
  const { state } = useLibrary();
  const books = state.books.filter((book): book is LibraryBook & { online: object } =>
    Boolean(book.online),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const queue = useRef<Job[]>([]);
  const running = useRef(new Map<string, string>());

  const pump = useRef<() => void>(() => undefined);
  pump.current = () => {
    while (running.current.size < PARALLEL && queue.current.length) {
      const job = queue.current.shift()!;
      const operationId = `offline-${job.bookId}-${Date.now()}`;
      running.current.set(operationId, job.bookId);
      setProgress((current) => ({
        ...current,
        [job.bookId]: { operationId, cached: 0, failed: 0, total: 0, state: "running" },
      }));
      void service
        .cacheChapters({ operationId, bookId: job.bookId, start: job.start, end: job.end })
        .catch((failure: unknown) => {
          running.current.delete(operationId);
          toast({ text: String(failure), error: true });
          pump.current();
        });
    }
  };

  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    void service
      .onCache((event) => {
        const bookId = running.current.get(event.operationId);
        if (!bookId) return;
        setProgress((current) => ({
          ...current,
          [bookId]: {
            operationId: event.done ? null : event.operationId,
            cached: event.cached,
            failed: event.failed,
            total: event.total,
            state: event.done ? "done" : "running",
          },
        }));
        if (event.done) {
          running.current.delete(event.operationId);
          pump.current();
          if (!running.current.size && !queue.current.length) void runtime.library.refresh();
        }
      })
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [service, runtime]);

  const start = (count: number | null) => {
    for (const book of books) {
      if (!selected.has(book.book.id) || progress[book.book.id]?.state === "running") continue;
      const from = book.online.readChapter ?? 0;
      queue.current.push({
        bookId: book.book.id,
        start: from,
        end: count === null ? book.online.totalChapters : from + count,
      });
      setProgress((current) => ({
        ...current,
        [book.book.id]: { operationId: null, cached: 0, failed: 0, total: 0, state: "queued" },
      }));
    }
    setSelected(new Set());
    pump.current();
  };

  const stopAll = () => {
    queue.current = [];
    for (const operationId of running.current.keys()) void service.cancel(operationId);
    setProgress((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, item]) => [
          id,
          item.state === "queued" ? { ...item, state: "done" as const } : item,
        ]),
      ),
    );
  };

  const busy = Object.values(progress).some((item) => item.state !== "done");
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <FullPage
      label="离线缓存"
      onClose={onClose}
      actions={
        busy ? (
          <Button variant="ghost" size="sm" onClick={stopAll}>
            停止
          </Button>
        ) : undefined
      }
    >
      {books.length === 0 ? (
        <p className="py-10 text-center text-sm text-secondary">书架上没有网络书籍。</p>
      ) : (
        <>
          <ul aria-label="网络书籍" className="space-y-1.5">
            {books.map((book) => {
              const item = progress[book.book.id];
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
                        {item?.state === "queued" && " · 等待中"}
                        {item?.state === "running" &&
                          ` · 缓存中 ${item.cached + item.failed}/${item.total || "…"}`}
                        {item?.state === "done" &&
                          ` · 本次缓存 ${item.cached} 章${item.failed ? `，失败 ${item.failed}` : ""}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="sticky bottom-0 -mx-3 px-3 pt-2 pb-3 bg-surface flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setSelected(new Set(books.map((book) => book.book.id)))}
            >
              全选
            </Button>
            <Button className="flex-1" disabled={!selected.size} onClick={() => start(50)}>
              后面 50 章
            </Button>
            <Button className="flex-1" disabled={!selected.size} onClick={() => start(null)}>
              全部
            </Button>
          </div>
        </>
      )}
    </FullPage>
  );
}

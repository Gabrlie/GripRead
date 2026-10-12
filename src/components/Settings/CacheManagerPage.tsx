import { useEffect, useState } from "react";
import { useRuntime } from "../../application/runtime";
import type { StorageUsage } from "../../types/generated";
import { appLog } from "../../services/log";
import { formatSize } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";

/** 缓存管理: what the app keeps on the device, and clearing the caches. */
export function CacheManagerPage({ onClose }: { onClose: () => void }) {
  const runtime = useRuntime();
  const service = runtime.services.sources;
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void service.storageUsage().then(
      (value) => active && setUsage(value),
      (failure: unknown) => toast({ text: String(failure), error: true }),
    );
    return () => {
      active = false;
    };
  }, [service, revision]);

  const clear = (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    void work()
      .then(
        () => {
          toast(done);
          setRevision((value) => value + 1);
          return runtime.library.refresh();
        },
        (failure: unknown) => toast({ text: String(failure), error: true }),
      )
      .finally(() => setBusy(false));
  };

  const total = usage?.parts.reduce((sum, part) => sum + part.bytes, 0) ?? 0;
  const clearable: Record<string, [() => Promise<unknown>, string]> = {
    chapters: [() => service.clearAllOnlineCaches(), "已清除章节缓存"],
    covers: [() => service.clearCoverCache(), "已清除封面缓存"],
    logs: [() => appLog.clear(), "已清除日志"],
  };

  return (
    <FullPage label="缓存管理" onClose={onClose}>
      <section className="rounded-2xl bg-surface-container-low p-4">
        <p className="text-xs text-secondary">应用占用</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">
          {usage ? formatSize(total) : "—"}
        </p>
      </section>
      <PageSection title="分类">
        {(usage?.parts ?? []).map((part) => {
          const action = clearable[part.key];
          return (
            <div key={part.key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="flex-1 min-w-0 truncate">{part.label}</span>
              <span className="text-secondary tabular-nums">{formatSize(part.bytes)}</span>
              {action && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={busy || part.bytes === 0}
                  onClick={() => clear(action[0], action[1])}
                >
                  清除
                </Button>
              )}
            </div>
          );
        })}
      </PageSection>
      {usage && usage.books.length > 0 && (
        <PageSection title="网络书籍的章节缓存">
          {usage.books.map((book) => (
            <div key={book.key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="flex-1 min-w-0 truncate">{book.label}</span>
              <span className="text-secondary tabular-nums">{formatSize(book.bytes)}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                disabled={busy}
                onClick={() =>
                  clear(() => service.clearOnlineCache(book.key), `已清除《${book.label}》的缓存`)
                }
              >
                清除
              </Button>
            </div>
          ))}
        </PageSection>
      )}
    </FullPage>
  );
}

import { useEffect, useState } from "react";
import { useRuntime } from "../../application/runtime";
import type { LibraryBook } from "../../types/generated";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "../ui/toast";

/** A chosen range, `[start, end)` in chapter positions. */
export interface ChapterRange {
  start: number;
  end: number;
}

/** The ranges Legado's 离线缓存 offers, from the chapter being read. */
export function presetRange(
  book: LibraryBook,
  preset: "next50" | "rest" | "all",
  current = book.online?.readChapter ?? 0,
): ChapterRange {
  const total = book.online?.totalChapters ?? 0;
  const from = current;
  if (preset === "all") return { start: 0, end: total };
  return { start: from, end: preset === "rest" ? total : Math.min(total, from + 50) };
}

/**
 * 缓存: which chapters of an online book to download. The presets start at
 * the chapter being read; 自定义 takes a range by chapter number, showing
 * each end's title. The range joins 下载管理, which runs in the background.
 */
export function CacheRangeDialog({
  book,
  current = book.online?.readChapter ?? 0,
  onClose,
}: {
  book: LibraryBook;
  /** The chapter being read, where the presets start. */
  current?: number;
  onClose: () => void;
}) {
  const runtime = useRuntime();
  const total = book.online?.totalChapters ?? 0;
  const [titles, setTitles] = useState<string[]>([]);
  const [from, setFrom] = useState(String(current + 1));
  const [to, setTo] = useState(String(total));

  useEffect(() => {
    let active = true;
    void runtime.services.reader.listToc(book.book.id).then(
      ({ entries }) =>
        active && setTitles(entries.filter((entry) => !entry.volume).map((entry) => entry.title)),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [runtime, book.book.id]);

  const queue = (range: ChapterRange) => {
    onClose();
    void runtime.services.sources.enqueueDownload(book.book.id, range.start, range.end).then(
      () => toast("已加入下载"),
      (failure: unknown) => toast({ text: String(failure), error: true }),
    );
  };

  const start = Math.max(1, Math.min(total, Number(from) || 1));
  const end = Math.max(start, Math.min(total, Number(to) || total));
  const titleAt = (number: number) => titles[number - 1] ?? "";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        initialFocus={false}
        className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3"
      >
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">缓存</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => queue(presetRange(book, "next50", current))}
          >
            后面 50 章
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => queue(presetRange(book, "rest", current))}
          >
            后面全部
          </Button>
          <Button variant="outline" size="sm" onClick={() => queue(presetRange(book, "all"))}>
            全部
          </Button>
        </div>
        <fieldset className="space-y-2 rounded-xl bg-surface-container-low p-3">
          <legend className="sr-only">自定义</legend>
          <span className="text-xs text-secondary">自定义（共 {total} 章）</span>
          {(
            [
              ["从第", from, setFrom, start],
              ["到第", to, setTo, end],
            ] as const
          ).map(([label, value, set, number]) => (
            <label key={label} className="flex items-center gap-2 text-sm">
              <span className="shrink-0">{label}</span>
              <input
                aria-label={`${label}几章`}
                inputMode="numeric"
                value={value}
                onChange={(change) => set(change.target.value.replace(/\D/g, ""))}
                className="w-16 h-8 rounded-lg bg-surface px-2 text-center tabular-nums outline-none"
              />
              <span className="shrink-0">章</span>
              <span className="flex-1 min-w-0 truncate text-[11px] text-secondary">
                {titleAt(number)}
              </span>
            </label>
          ))}
          <Button
            size="sm"
            className="w-full"
            disabled={total === 0}
            onClick={() => queue({ start: start - 1, end })}
          >
            缓存第 {start}–{end} 章
          </Button>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}

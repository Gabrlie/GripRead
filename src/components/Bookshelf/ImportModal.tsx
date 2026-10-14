import { useEffect, useState } from "react";
import type { TxtEncoding } from "../../types/generated";
import { useLibrary } from "../../application/runtime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";

const labels = {
  staging: "等待导入",
  reading: "读取文件",
  normalizing: "准备正文",
  persisting: "保存到本地",
  completed: "导入完成",
  failed: "导入失败",
  cancelled: "导入已取消",
};

const encodingOptions: { value: Exclude<TxtEncoding, "auto">; label: string }[] = [
  { value: "utf8", label: "UTF-8" },
  { value: "gb18030", label: "GB18030" },
  { value: "gbk", label: "GBK" },
  { value: "utf16_le", label: "UTF-16 LE" },
  { value: "utf16_be", label: "UTF-16 BE" },
];

export function ImportModal() {
  const { state, store } = useLibrary();
  const [open, setOpen] = useState(false);
  const [encoding, setEncoding] = useState<Exclude<TxtEncoding, "auto">>("gb18030");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const notice = state.importNotice;
  const outcome = state.importOutcome;
  const terminalStatus = state.job ?? outcome?.status ?? null;

  useEffect(() => {
    if (state.importDetailsRequested) {
      setOpen(true);
      store.consumeImportDetailsRequest();
    }
  }, [state.importDetailsRequested, store]);

  useEffect(() => {
    if (!notice) {
      setHovered(false);
      setFocused(false);
      return;
    }
    if (open || hovered || focused) store.pauseImportNotice(notice.id);
    else store.resumeImportNotice(notice.id);
  }, [notice?.id, hovered, focused, open, notice, store]);

  if (!state.importing && !notice && !state.importDetailsRequested && !open) return null;

  const statusLabel = state.job
    ? labels[state.job.phase]
    : state.importing
      ? "等待文件选择"
      : labels[outcome?.phase ?? "failed"];
  const errorDetails = state.importing ? state.importError : (outcome?.error ?? state.importError);
  const importResult = (state.importing ? state.job?.result : terminalStatus?.result) ?? null;
  const retryWithEncoding =
    !state.importing && outcome?.phase === "failed" && outcome.retryWithEncoding;
  const retryAvailable = !state.importing && outcome?.phase === "failed";

  const retryImport = () => {
    setOpen(false);
    if (retryWithEncoding) void store.importTxt(undefined, encoding);
    else void store.importTxt();
  };

  return (
    <>
      {state.importing && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-[calc(6rem+var(--safe-bottom))] md:bottom-5 right-5 z-[60] flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-full border border-surface-variant bg-surface-container px-4 py-2 text-sm shadow-sm"
          aria-label="查看导入进度"
        >
          <span>{statusLabel}</span>
          {state.job?.phase === "reading" && state.job.totalBytes ? (
            <span className="text-xs text-secondary">
              {Math.round((state.job.bytesRead / state.job.totalBytes) * 100)}%
            </span>
          ) : null}
        </button>
      )}

      {notice && (
        <div
          className="fixed bottom-[calc(6rem+var(--safe-bottom))] md:bottom-5 right-5 z-[60] flex max-w-[calc(100vw-2.5rem)] items-center gap-1 rounded-full border border-surface-variant bg-surface-container px-2 py-1.5 text-sm shadow-sm"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(event) => {
            const next = event.relatedTarget as Node | null;
            if (!next || !event.currentTarget.contains(next)) setFocused(false);
          }}
        >
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="truncate px-2 py-1 text-left"
          >
            {notice.message}
            {notice.phase === "completed" && importResult
              ? `：${importResult.book.title}`
              : notice.phase === "failed"
                ? " · 查看详情"
                : ""}
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭导入提示"
            onClick={() => store.dismissImportNotice(notice.id)}
          >
            <span aria-hidden="true">×</span>
          </Button>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-2xl border border-surface-variant/40 bg-surface p-5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-title-editorial">导入本地书籍</DialogTitle>
            <DialogDescription>导入在后台运行；关闭此面板不会中断任务。</DialogDescription>
          </DialogHeader>

          <p role="status" className="text-sm text-primary">
            {statusLabel}
          </p>

          {state.job?.phase === "reading" && (
            <>
              <Progress
                value={
                  state.job.totalBytes ? (state.job.bytesRead / state.job.totalBytes) * 100 : 0
                }
                aria-label="导入进度"
              />
              <p className="text-xs text-secondary">
                {state.job.bytesRead} / {state.job.totalBytes} 字节
              </p>
            </>
          )}

          {!state.importing && outcome?.phase === "completed" && importResult && (
            <p className="text-sm">
              {importResult.duplicate ? "已复用已有书籍" : "书籍已保存"}：{importResult.book.title}
            </p>
          )}

          {errorDetails && (
            <p role="alert" className="break-words text-sm text-error">
              {errorDetails}
            </p>
          )}

          {retryWithEncoding && (
            <label className="flex flex-col gap-2 text-sm">
              <span>自动识别失败，请选择编码后重新选择文件</span>
              <select
                value={encoding}
                onChange={(event) =>
                  setEncoding(event.target.value as Exclude<TxtEncoding, "auto">)
                }
                className="h-9 rounded-lg border border-surface-variant bg-surface px-3"
              >
                {encodingOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <DialogFooter>
            {state.importing && (
              <Button variant="outline" disabled={!state.job} onClick={() => void store.cancel()}>
                取消导入
              </Button>
            )}
            {retryAvailable && (
              <Button variant="outline" onClick={retryImport}>
                {retryWithEncoding ? "选择文件并按编码重试" : "重新选择文件"}
              </Button>
            )}
            <Button variant="outline" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { useEffect, useState } from "react";
import { useLibrary } from "../../application/runtime";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
const labels = {
  staging: "等待导入",
  reading: "读取文件",
  normalizing: "规范化正文",
  persisting: "提交到本地",
  completed: "导入完成",
  failed: "导入失败",
  cancelled: "导入已取消",
};
export function ImportModal() {
  const { state, store } = useLibrary();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (state.importing || state.importError) setOpen(true);
  }, [state.importing, state.importError]);
  if (!state.job && !state.importing && !state.importError) return null;
  const label = state.job ? labels[state.job.phase] : state.importing ? "正在选择文件" : "导入失败";
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-24 md:bottom-5 right-5 z-[60] rounded-full bg-surface-container border border-surface-variant px-4 py-2 text-sm shadow-sm"
        aria-label="查看导入状态"
      >
        {label}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-surface border border-surface-variant/40 rounded-2xl p-5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-title-editorial">导入本地 TXT</DialogTitle>
            <DialogDescription>
              TXT 正文会自动识别编码并保存到本地。关闭面板后导入继续。
            </DialogDescription>
          </DialogHeader>
          <p role="status" className="text-sm text-primary">
            {label}
          </p>
          {state.job && (
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
          {state.job?.phase === "completed" && state.job.result && (
            <p>
              {state.job.result.duplicate ? "已复用已有书籍" : "书籍已保存"}：
              {state.job.result.book.title}
            </p>
          )}
          {state.importError && (
            <p role="alert" className="text-error text-sm break-words">
              {state.importError}
            </p>
          )}
          <DialogFooter>
            {state.importing && (
              <Button variant="outline" disabled={!state.job} onClick={() => void store.cancel()}>
                取消导入
              </Button>
            )}
            <Button onClick={() => setOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

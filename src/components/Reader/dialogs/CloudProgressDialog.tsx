import type { ProgressPrompt } from "../../../types/generated";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

/**
 * Legado's 云端进度 question: another device read this book to a different
 * place; jump there or stay. Either answer is remembered for that position.
 */
export function CloudProgressDialog({
  prompt,
  onAnswer,
}: {
  prompt: ProgressPrompt;
  onAnswer: (jump: boolean) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onAnswer(false)}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">云端进度</DialogTitle>
          <DialogDescription>
            {prompt.deviceName || "另一台设备"} ·{" "}
            {new Date(prompt.writtenAt).toLocaleString("zh-CN", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          云端进度与当前不同，是否跳转？
          <span className="block mt-1 text-xs text-secondary break-words">
            {prompt.chapterTitle && `${prompt.chapterTitle} · `}
            {prompt.excerpt}
          </span>
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onAnswer(false)}>
            取消
          </Button>
          <Button size="sm" onClick={() => onAnswer(true)}>
            跳转
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

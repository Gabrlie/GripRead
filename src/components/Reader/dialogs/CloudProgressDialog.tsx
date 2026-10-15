import type { ProgressPrompt, ReaderLocator, TocEntry } from "../../../types/generated";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

/**
 * The contents entry a position is in: by chapter for an online book, whose
 * chapters are separate resources, else by offset in the one text.
 */
export function chapterIndexOf(toc: readonly TocEntry[], locator: ReaderLocator): number {
  const chaptered = toc.length > 1 && toc[0].locator.resourceId !== toc.at(-1)!.locator.resourceId;
  if (chaptered) return toc.findIndex((entry) => entry.locator.resourceId === locator.resourceId);
  let found = -1;
  for (let index = 0; index < toc.length; index += 1) {
    if (toc[index].locator.offset <= locator.offset) found = index;
    else break;
  }
  return found;
}

/** How the cloud position compares with this device's, in chapters. */
export function chapterGap(cloud: number, here: number): string | null {
  if (cloud < 0 || here < 0) return null;
  if (cloud === here) return "在同一章";
  return cloud > here ? `云端领先 ${cloud - here} 章` : `云端落后 ${here - cloud} 章`;
}

/**
 * Legado's 云端进度 question: another device read this book to a different
 * place; jump there or stay. Both places are shown with their chapters and
 * the gap between them. Either answer is remembered for that position.
 */
export function CloudProgressDialog({
  prompt,
  toc,
  here,
  onAnswer,
}: {
  prompt: ProgressPrompt;
  toc: readonly TocEntry[];
  /** This device's current position. */
  here: ReaderLocator | null;
  onAnswer: (jump: boolean) => void;
}) {
  const cloudIndex = chapterIndexOf(toc, prompt.locator);
  const hereIndex = here ? chapterIndexOf(toc, here) : -1;
  const place = (index: number, fallback: string) =>
    index >= 0 ? `第 ${index + 1} 章 · ${toc[index].title}` : fallback;
  const gap = chapterGap(cloudIndex, hereIndex);
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
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-secondary">云端</dt>
          <dd className="min-w-0">
            <span className="block truncate">
              {place(cloudIndex, prompt.chapterTitle || "未知章节")}
            </span>
            {prompt.excerpt && (
              <span className="block text-xs text-secondary truncate">{prompt.excerpt}</span>
            )}
          </dd>
          <dt className="text-secondary">本机</dt>
          <dd className="min-w-0 truncate">{place(hereIndex, "未知章节")}</dd>
        </dl>
        <p className="text-sm">{gap ? `${gap}，` : "云端进度与当前不同，"}是否跳转到云端进度？</p>
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

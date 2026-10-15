import type { ProgressPrompt, ReaderLocator, TocEntry } from "../../../types/generated";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { formatDateTime, t } from "../../../i18n";

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
  if (cloud === here) return t("cloud.sameChapter");
  return cloud > here
    ? t("cloud.ahead", { count: cloud - here })
    : t("cloud.behind", { count: here - cloud });
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
    index >= 0 ? t("cloud.place", { number: index + 1, title: toc[index].title }) : fallback;
  const gap = chapterGap(cloudIndex, hereIndex);
  return (
    <Dialog open onOpenChange={(open) => !open && onAnswer(false)}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">{t("cloud.title")}</DialogTitle>
          <DialogDescription>
            {prompt.deviceName || t("cloud.otherDevice")} ·{" "}
            {formatDateTime(prompt.writtenAt, {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-secondary">{t("cloud.cloud")}</dt>
          <dd className="min-w-0">
            <span className="block truncate">
              {place(cloudIndex, prompt.chapterTitle || t("cloud.unknownChapter"))}
            </span>
            {prompt.excerpt && (
              <span className="block text-xs text-secondary truncate">{prompt.excerpt}</span>
            )}
          </dd>
          <dt className="text-secondary">{t("cloud.here")}</dt>
          <dd className="min-w-0 truncate">{place(hereIndex, t("cloud.unknownChapter"))}</dd>
        </dl>
        <p className="text-sm">{gap ? t("cloud.askGap", { gap }) : t("cloud.askDiffer")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onAnswer(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => onAnswer(true)}>
            {t("cloud.jump")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

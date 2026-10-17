import { useEffect, useState } from "react";
import type { TocSuggestion } from "../../types/generated";
import { useRuntime } from "../../application/runtime";
import { t } from "../../i18n";
import { describeError } from "../Cloud/format";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "../ui/toast";

/** Books asked (or being checked) this session, whichever page got there first. */
const claimed = new Set<string>();

/**
 * The one-time question about a book's contents: a disabled rule that finds
 * its chapters, or chapters inside an online book's chapters. The detail
 * page and the reader both show it, and the first to open asks; the answer
 * (closing counts as 不用了) is kept with the book, and later changes are
 * made in the contents More menu.
 */
export function TocSuggestionPrompt({
  bookId,
  onAnswered,
}: {
  bookId: string;
  /** After the book's contents settings were saved. */
  onAnswered?: () => void;
}) {
  const runtime = useRuntime();
  const reader = runtime.services.reader;
  const [suggestion, setSuggestion] = useState<TocSuggestion | null>(null);
  useEffect(() => {
    if (claimed.has(bookId) || typeof reader.tocSuggestion !== "function") return;
    claimed.add(bookId);
    let active = true;
    void reader.tocSuggestion(bookId).then(
      (found) => {
        if (!active) return claimed.delete(bookId);
        if (found) setSuggestion(found);
        // Nothing to ask yet (an online book's chapters may come later).
        else claimed.delete(bookId);
      },
      () => claimed.delete(bookId),
    );
    return () => {
      active = false;
    };
  }, [bookId, reader]);
  if (!suggestion) return null;

  const answer = (accept: boolean) => {
    setSuggestion(null);
    void reader
      .listToc(bookId)
      .then(({ settings }) =>
        reader.saveBookTocSettings(bookId, {
          ...settings,
          asked: true,
          ...(accept && suggestion.kind === "rule" ? { ruleId: suggestion.ruleId } : {}),
          ...(accept && suggestion.kind === "inner"
            ? { innerChapters: true, ruleId: suggestion.ruleId }
            : {}),
        }),
      )
      .then(
        () => onAnswered?.(),
        (failure: unknown) => toast({ text: describeError(failure), error: true }),
      );
  };
  const inner = suggestion.kind === "inner";
  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("contents.askTitle")}
          </DialogTitle>
          <DialogDescription>
            {t(inner ? "contents.askInner" : "contents.askRule", {
              rule: suggestion.ruleName,
              count: suggestion.count,
            })}
          </DialogDescription>
        </DialogHeader>
        <ul className="rounded-xl bg-surface-container-low px-3 py-2 text-sm space-y-1 max-h-48 overflow-y-auto">
          {suggestion.titles.map((title, index) => (
            <li key={index} className="truncate">
              {title}
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-secondary">{t("contents.askLater")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => answer(false)}>
            {t("contents.askNo")}
          </Button>
          <Button size="sm" onClick={() => answer(true)}>
            {inner ? t("contents.askInnerYes") : t("contents.askRuleYes")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

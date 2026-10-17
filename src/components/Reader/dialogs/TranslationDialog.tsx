import { useEffect, useState } from "react";
import { useRuntime } from "../../../application/runtime";
import { LANGUAGES, languageName, sameLanguage } from "../../../application/translation";
import { errorText, t } from "../../../i18n";
import type {
  BookTranslation,
  BookTranslationEvent,
  TranslationSettings,
} from "../../../types/generated";
import { describeError } from "../../Cloud/format";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Switch } from "../../ui/switch";
import { toast } from "../../ui/toast";

const selectClass =
  "shrink-0 max-w-[50%] truncate rounded-lg border border-surface-variant bg-surface-container px-2 py-1.5 text-sm";

/**
 * 翻译 from the reader's menu: the book's language (detected, or chosen),
 * reading it translated into the language of 设置 › 翻译, and how the
 * translation reads. `onChanged` shows the book again in place. A local
 * book is translated by a background job, shown here while it runs.
 */
export function TranslationDialog({
  bookId,
  online,
  onChanged,
  onOpenSettings,
  onClose,
}: {
  bookId: string;
  online: boolean;
  onChanged: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const service = useRuntime().services.translation;
  const [settings, setSettings] = useState<TranslationSettings | null>(null);
  const [book, setBook] = useState<BookTranslation | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BookTranslationEvent | null>(null);

  useEffect(() => {
    if (online) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    void service
      .onBookProgress((event) => {
        if (event.bookId === bookId) setProgress(event);
      })
      .then((stop) => (active ? (unlisten = stop) : stop()));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [service, bookId, online]);

  useEffect(() => {
    let active = true;
    void service.getSettings().then(
      (value) => active && setSettings(value),
      () => undefined,
    );
    void service.getBook(bookId).then(
      (value) => active && setBook(value),
      (failure: unknown) => toast({ text: describeError(failure), error: true }),
    );
    return () => {
      active = false;
    };
  }, [service, bookId]);

  const change = (work: () => Promise<BookTranslation>) => {
    setBusy(true);
    void work()
      .then(
        (value) => {
          setBook(value);
          onChanged();
          if (online) return;
          if (value.translateTo) void service.translateBook(bookId, false);
          else void service.stopBook(bookId);
        },
        (failure: unknown) => toast({ text: describeError(failure), error: true }),
      )
      .finally(() => setBusy(false));
  };
  const saveDisplay = (display: TranslationSettings["display"]) => {
    if (!settings) return;
    const next = { ...settings, display };
    setSettings(next);
    void service.saveSettings(next).then(() => book?.translateTo && onChanged());
  };

  const hasEngine = Boolean(settings?.engines.length);
  // The book's own language to read in, else 设置 › 翻译's default.
  const [picked, setPicked] = useState<string | null>(null);
  const target = picked ?? book?.translateTo ?? settings?.target ?? "zh-CN";
  const same = sameLanguage(book?.language, target);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("translation.title")}
          </DialogTitle>
          <DialogDescription>{t("translation.book.slow")}</DialogDescription>
        </DialogHeader>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate">{t("translation.book.language")}</span>
          {book ? (
            <select
              aria-label={t("translation.book.language")}
              className={selectClass}
              value={book.language ?? ""}
              disabled={busy}
              onChange={(event) =>
                change(() => service.setLanguage(bookId, event.target.value || null))
              }
            >
              <option value="">{t("translation.book.unknown")}</option>
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {languageName(code)}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-secondary">{t("translation.book.detecting")}</span>
          )}
        </label>
        {!hasEngine ? (
          <div className="space-y-2">
            <p className="text-xs text-secondary">{t("translation.book.needEngine")}</p>
            <Button size="sm" variant="outline" onClick={onOpenSettings}>
              {t("translation.book.openSettings")}
            </Button>
          </div>
        ) : (
          <>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate">{t("translation.book.into")}</span>
              <select
                aria-label={t("translation.book.into")}
                className={selectClass}
                value={target}
                disabled={busy || !book}
                onChange={(event) => {
                  const next = event.target.value;
                  setPicked(next);
                  // A book read translated switches language at once.
                  if (book?.translateTo) change(() => service.setBook(bookId, next));
                }}
              >
                {LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {languageName(code)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {t("translation.book.on", { target: languageName(target) })}
              </span>
              <Switch
                aria-label={t("translation.book")}
                checked={Boolean(book?.translateTo)}
                disabled={busy || !book}
                onCheckedChange={(on) => change(() => service.setBook(bookId, on ? target : null))}
              />
            </label>
            {!online && book?.translateTo && (
              <LocalProgress
                progress={progress}
                onRun={(whole) => void service.translateBook(bookId, whole)}
                onStop={() => void service.stopBook(bookId)}
              />
            )}
            {same && !book?.translateTo && (
              <p className="text-[11px] text-secondary">
                {t("translation.book.same", { target: languageName(target) })}
              </p>
            )}
            <div
              role="radiogroup"
              aria-label={t("translation.display")}
              className="grid grid-cols-2 gap-1 bg-surface-container p-1 rounded-lg"
            >
              {(["translated", "bilingual"] as const).map((display) => (
                <button
                  key={display}
                  type="button"
                  role="radio"
                  aria-checked={settings?.display === display}
                  onClick={() => settings?.display !== display && saveDisplay(display)}
                  className={`h-8 rounded-md text-xs ${settings?.display === display ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
                >
                  {t(`translation.display.${display}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="text-left text-[11px] text-primary"
              onClick={onOpenSettings}
            >
              {t("translation.book.openSettings")}
            </button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LocalProgress({
  progress,
  onRun,
  onStop,
}: {
  progress: BookTranslationEvent | null;
  onRun: (whole: boolean) => void;
  onStop: () => void;
}) {
  const running = Boolean(progress && !progress.finished);
  return (
    <div className="space-y-2 rounded-lg bg-surface-container px-3 py-2 text-xs">
      <p className="text-secondary">{t("translation.book.local")}</p>
      {progress && progress.total > 0 && (
        <p role="status">
          {progress.finished && !progress.error && progress.done === progress.total
            ? t("translation.book.done")
            : t("translation.book.progress", { done: progress.done, total: progress.total })}
        </p>
      )}
      {progress?.error && (
        <p role="alert" className="text-error break-words">
          {t("translation.book.failed", { error: errorText(progress.error) })}
        </p>
      )}
      <div className="flex gap-2">
        {running ? (
          <Button size="sm" variant="outline" onClick={onStop}>
            {t("translation.book.stop")}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => onRun(false)}>
              {t("translation.book.continue")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onRun(true)}>
              {t("translation.book.whole")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useRuntime, useSettings } from "../../application/runtime";
import type { DataPart, DataUsage } from "../../types/generated";
import { formatSize } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { useT, type MessageKey } from "../../i18n";

/** Parts chosen when the page opens: every cache except the shelf's chapters. */
const UNCHOSEN = new Set(["shelved"]);

/** Bar colours: caches in the primary hue, kept data in a quiet one. */
function partColour(part: DataPart, index: number): string {
  const alpha = [1, 0.72, 0.5, 0.34, 0.22][index % 5];
  return part.clearable
    ? `rgb(var(--color-primary-rgb) / ${alpha})`
    : `rgb(var(--color-on-surface-variant-rgb) / ${0.45 - (index % 4) * 0.09})`;
}

/**
 * 数据管理, laid out like Android's storage page: a stacked bar of what the
 * app keeps, the caches to clear (chosen by default except the shelf's
 * chapters), and the shelf's online books with their chapter caches.
 */
export function DataManagerPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const partName = (part: DataPart) => {
    const key = `data.part.${part.key}` as MessageKey;
    const name = t(key);
    return name === key ? part.label : name;
  };
  const runtime = useRuntime();
  const service = runtime.services.sources;
  const { state: settings, store: settingsStore } = useSettings();
  const [usage, setUsage] = useState<DataUsage | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void service.dataUsage().then(
      (value) => {
        if (!active) return;
        setUsage(value);
        setChosen(
          (current) =>
            current ??
            new Set(
              value.parts
                .filter((part) => part.clearable && !UNCHOSEN.has(part.key))
                .map((part) => part.key),
            ),
        );
      },
      (failure: unknown) => toast({ text: String(failure), error: true }),
    );
    return () => {
      active = false;
    };
  }, [service, revision]);

  const parts = usage?.parts ?? [];
  const total = parts.reduce((sum, part) => sum + part.bytes, 0);
  const cached = parts.reduce((sum, part) => sum + (part.clearable ? part.bytes : 0), 0);
  const chosenBytes = useMemo(
    () => parts.filter((part) => chosen?.has(part.key)).reduce((sum, part) => sum + part.bytes, 0),
    [parts, chosen],
  );

  const run = (work: () => Promise<unknown>, done: string) => {
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

  const toggle = (key: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <FullPage label={t("data.title")} onClose={onClose}>
      <section className="rounded-2xl bg-surface-container-low p-4 space-y-4">
        <p className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">{formatSize(cached)}</span>
          <span className="text-xs text-secondary">{t("data.cache")}</span>
        </p>
        <div
          role="img"
          aria-label={t("data.usage")}
          className="flex h-3 w-full overflow-hidden rounded-full bg-surface-container-highest"
        >
          {total > 0 &&
            parts.map((part, index) =>
              part.bytes > 0 ? (
                <span
                  key={part.key}
                  style={{
                    width: `${(part.bytes / total) * 100}%`,
                    minWidth: 2,
                    backgroundColor: partColour(part, index),
                  }}
                />
              ) : null,
            )}
        </div>
        <ul aria-label={t("data.parts")} className="space-y-1">
          {parts.map((part, index) => {
            const on = chosen?.has(part.key) ?? false;
            const row = (
              <>
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: partColour(part, index) }}
                />
                <span className="flex-1 min-w-0 truncate text-sm">{partName(part)}</span>
                <span className="text-xs text-secondary tabular-nums">
                  {formatSize(part.bytes)}
                </span>
              </>
            );
            return (
              <li key={part.key}>
                {part.clearable ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={partName(part)}
                    disabled={busy}
                    onClick={() => toggle(part.key)}
                    className="w-full flex items-center gap-2.5 rounded-lg px-1 py-2 text-left"
                  >
                    <Icon
                      name={on ? "check_box" : "check_box_outline"}
                      size={18}
                      className="text-primary shrink-0"
                    />
                    {row}
                  </button>
                ) : (
                  <div className="flex items-center gap-2.5 px-1 py-2 opacity-80">
                    <span className="w-[18px] shrink-0" />
                    {row}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <Button
          className="w-full"
          disabled={busy || !chosen?.size || chosenBytes === 0}
          onClick={() => run(() => service.clearData([...(chosen ?? [])]), t("data.cleared"))}
        >
          {t("data.clearChosen", { size: formatSize(chosenBytes) })}
        </Button>
      </section>

      <PageSection>
        <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span>{t("data.clearOnExit")}</span>
          <Switch
            aria-label={t("data.clearOnExit")}
            checked={settings.value?.clearCacheOnExit ?? false}
            onCheckedChange={(clearCacheOnExit) => settingsStore.set({ clearCacheOnExit })}
          />
        </label>
      </PageSection>

      {usage && usage.books.length > 0 && (
        <PageSection title={t("data.onlineBooks")}>
          {usage.books.map((book) => (
            <div key={book.bookId} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate">{book.title}</span>
                <span className="block text-[11px] text-secondary tabular-nums">
                  {t("data.cached", {
                    cached: book.cachedChapters,
                    total: book.totalChapters,
                    size: formatSize(book.bytes),
                  })}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                disabled={busy || book.bytes === 0}
                onClick={() =>
                  run(
                    () => service.clearOnlineCache(book.bookId),
                    t("data.bookCleared", { title: book.title }),
                  )
                }
              >
                {t("data.clear")}
              </Button>
            </div>
          ))}
        </PageSection>
      )}
    </FullPage>
  );
}

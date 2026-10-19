import { useEffect, useState } from "react";
import { serverAccount, type JobSettings, type JobStatus } from "../../services/server";
import { describeError } from "../Cloud/format";
import { PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { formatDateTime, t } from "../../i18n";
import { refreshIntervals } from "../Rss/format";

const intervals = (): [number, string][] => [
  [0, t("common.off")],
  [1, t("aloud.60")],
  [3, t("jobs.3h")],
  [6, t("jobs.6h")],
  [12, t("jobs.12h")],
];
const PREFETCH = [0, 3, 5, 10];

function timeLabel(at: number | null): string {
  return at ? formatDateTime(at) : "—";
}

/**
 * 定时追更: how often the server updates its online books and how many new
 * chapters it fetches ahead; connected devices get them by sync.
 */
export function JobsSection() {
  const [settings, setSettings] = useState<JobSettings | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = () =>
    void serverAccount.jobs().then(
      (jobs) => {
        setSettings(jobs.settings);
        setStatus(jobs.status);
        setFailure(null);
      },
      (error: unknown) => setFailure(describeError(error)),
    );
  useEffect(load, []);

  const save = (change: Partial<JobSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...change };
    setSettings(next);
    void serverAccount.saveJobs(next).then(
      () => load(),
      (error: unknown) => toast({ text: describeError(error), error: true }),
    );
  };

  const updateNow = () => {
    setBusy(true);
    void serverAccount
      .updateNow()
      .then(
        () => toast(t("jobs.updated")),
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => {
        setBusy(false);
        load();
      });
  };

  if (!settings)
    return failure ? (
      <PageSection title={t("jobs.title")}>
        <p role="alert" className="p-4 text-xs text-error">
          {failure}
        </p>
      </PageSection>
    ) : null;
  const choice = (
    label: string,
    options: [number, string][],
    value: number,
    onPick: (value: number) => void,
  ) => (
    <div className="space-y-2">
      <span className="text-sm">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid gap-1 bg-surface-container p-1 rounded-lg"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            onClick={() => value !== option && onPick(option)}
            className={`h-8 rounded-md text-xs ${value === option ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <PageSection title={t("jobs.title")}>
      <div className="p-4 space-y-4">
        {choice(t("jobs.interval"), intervals(), settings.intervalHours, (intervalHours) =>
          save({ intervalHours }),
        )}
        {choice(
          t("jobs.prefetch"),
          PREFETCH.map((count) => [
            count,
            count ? t("detail.chapters", { count }) : t("jobs.noPrefetch"),
          ]),
          settings.prefetch,
          (prefetch) => save({ prefetch }),
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-secondary">
            {status?.running
              ? t("jobs.running")
              : status?.lastRun
                ? `${t("jobs.last", { time: timeLabel(status.lastRun), updated: status.updated, chapters: status.newChapters })}${status.failed ? t("shelf.updatedFailed", { failed: status.failed }) : ""}`
                : t("jobs.never")}
            {status?.nextRun ? (
              <span className="block">{t("jobs.next", { time: timeLabel(status.nextRun) })}</span>
            ) : null}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || status?.running}
            onClick={updateNow}
          >
            {busy ? t("detail.updating") : t("update.install")}
          </Button>
        </div>
        {status?.failures?.length ? (
          <details className="rounded-lg bg-surface-container-low px-3 py-2 text-xs">
            <summary className="cursor-pointer text-error">
              {t("jobs.failures", { count: status.failures.length })}
            </summary>
            <ul className="mt-2 space-y-1.5">
              {status.failures.map((failure, index) => (
                <li key={`${failure.title}-${index}`}>
                  <span className="block">{failure.title || t("jobs.unknownBook")}</span>
                  <span className="block text-[11px] text-secondary break-words">
                    {failure.error}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {settings.rssIntervalMinutes !== undefined &&
          choice(
            t("jobs.rssInterval"),
            refreshIntervals([0, 30, 60, 180]),
            settings.rssIntervalMinutes,
            (rssIntervalMinutes) => save({ rssIntervalMinutes }),
          )}
        <p className="text-[11px] text-secondary">{t("jobs.note")}</p>
      </div>
    </PageSection>
  );
}

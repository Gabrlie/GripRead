import { useEffect, useState } from "react";
import { serverAccount, type JobSettings, type JobStatus } from "../../services/server";
import { describeError } from "../Cloud/format";
import { PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";

const INTERVALS: [number, string][] = [
  [0, "关闭"],
  [1, "1 小时"],
  [3, "3 小时"],
  [6, "6 小时"],
  [12, "12 小时"],
];
const PREFETCH = [0, 3, 5, 10];

function timeLabel(at: number | null): string {
  return at ? new Date(at).toLocaleString() : "—";
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
        () => toast("书架已更新"),
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => {
        setBusy(false);
        load();
      });
  };

  if (!settings)
    return failure ? (
      <PageSection title="定时追更">
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
    <PageSection title="定时追更">
      <div className="p-4 space-y-4">
        {choice("更新间隔", INTERVALS, settings.intervalHours, (intervalHours) =>
          save({ intervalHours }),
        )}
        {choice(
          "预先缓存新章节",
          PREFETCH.map((count) => [count, count ? `${count} 章` : "不缓存"]),
          settings.prefetch,
          (prefetch) => save({ prefetch }),
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-secondary">
            {status?.running
              ? "正在更新…"
              : status?.lastRun
                ? `上次 ${timeLabel(status.lastRun)}：${status.updated} 本更新，${status.newChapters} 个新章节${status.failed ? `，${status.failed} 本失败` : ""}`
                : "尚未更新"}
            {status?.nextRun ? (
              <span className="block">下次 {timeLabel(status.nextRun)}</span>
            ) : null}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || status?.running}
            onClick={updateNow}
          >
            {busy ? "更新中…" : "立即更新"}
          </Button>
        </div>
        <p className="text-[11px] text-secondary">
          连接服务器的设备会同步到新章节，也会经由服务器读取章节。
        </p>
      </div>
    </PageSection>
  );
}

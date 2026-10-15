import { useEffect, useState } from "react";
import type { LogEntry, LogLevel } from "../../types/generated";
import { appLog } from "../../services/log";
import { copyText, system } from "../../services/system";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { formatDateTime, t, useT, type MessageKey } from "../../i18n";

const LEVELS: LogLevel[] = ["error", "warn", "info", "detail"];

const LEVEL_MARK: Record<LogLevel, string> = {
  error: "text-error",
  warn: "text-amber-600 dark:text-amber-400",
  info: "text-secondary",
  detail: "text-secondary/70",
};

/** The log areas the interface names; others show as written. */
const AREAS = [
  "server",
  "sync",
  "source",
  "reader",
  "library",
  "import",
  "download",
  "network",
  "update",
  "app",
];

function areaName(area: string): string {
  return AREAS.includes(area) ? t(`logs.area.${area}` as MessageKey) : area;
}

function time(value: number): string {
  return formatDateTime(value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * 日志: what failed and when, to send when something goes wrong. Cookies,
 * passwords, and login headers never enter it. 详细日志 also records every
 * source request and step for a day.
 */
export function LogPage({ onClose, layer }: { onClose: () => void; layer?: string }) {
  const t = useT();
  const [level, setLevel] = useState<LogLevel>("info");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [detailUntil, setDetailUntil] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [area, setArea] = useState<string | null>(null);
  const areas = [...new Set(entries.map((entry) => entry.area))].sort();
  const shown = area ? entries.filter((entry) => entry.area === area) : entries;

  useEffect(() => {
    let active = true;
    void appLog.list(level).then((page) => {
      if (!active) return;
      setEntries([...page.entries].reverse());
      setDetailUntil(page.detailUntil);
    });
    return () => {
      active = false;
    };
  }, [level, revision]);

  const share = async (method: "copy" | "share") => {
    const text = await appLog.exportText();
    if (!text.trim()) {
      toast(t("logs.empty"));
      return;
    }
    if (method === "copy") {
      await copyText(text);
      toast(t("logs.copied"));
    } else if ((await system.share(text)) === "copied") toast(t("logs.copied"));
  };

  return (
    <FullPage label={t("logs.title")} onClose={onClose} layer={layer}>
      <section className="rounded-xl bg-surface-container-low px-4 py-3 flex items-center gap-3">
        <span className="flex-1 min-w-0">
          <span className="block text-sm">{t("logs.detailed")}</span>
          <span className="block text-[11px] text-secondary">
            {detailUntil
              ? t("logs.detailedUntil", { time: time(detailUntil) })
              : t("logs.detailed.note")}
          </span>
        </span>
        <Switch
          aria-label={t("logs.detailed")}
          checked={detailUntil !== null}
          onCheckedChange={(on) =>
            void appLog.setDetailed(on).then((until) => {
              setDetailUntil(until);
              setRevision((value) => value + 1);
            })
          }
        />
      </section>
      <div className="flex items-center gap-1.5 flex-wrap">
        {LEVELS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={level === value}
            onClick={() => setLevel(value)}
            className={`h-7 px-3 rounded-full text-xs ${
              level === value
                ? "bg-primary text-on-primary"
                : "bg-surface-container-low text-secondary"
            }`}
          >
            {t(`logs.filter.${value}`)}
          </button>
        ))}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>
          {t("logs.refresh")}
        </Button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={() => void share("copy")}>
          {t("logs.copyAll")}
        </Button>
        <Button size="sm" variant="outline" className="flex-1" onClick={() => void share("share")}>
          {t("logs.share")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 text-error"
          onClick={() =>
            void appLog.clear().then(() => {
              setEntries([]);
              toast(t("logs.cleared"));
            })
          }
        >
          {t("logs.clear")}
        </Button>
      </div>
      {areas.length > 1 && (
        <div
          role="group"
          aria-label={t("logs.areas")}
          className="flex items-center gap-1.5 flex-wrap"
        >
          {[null, ...areas].map((value) => (
            <button
              key={value ?? "all"}
              type="button"
              aria-pressed={area === value}
              onClick={() => setArea(value)}
              className={`h-6 px-2.5 rounded-full text-[11px] ${
                area === value
                  ? "bg-secondary-container text-on-secondary-container"
                  : "bg-surface-container-low text-secondary"
              }`}
            >
              {value === null ? t("logs.allAreas") : areaName(value)}
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-secondary">{t("logs.none")}</p>
      ) : (
        <ul aria-label={t("logs.title")} className="space-y-1.5">
          {shown.map((entry, index) => (
            <li
              key={`${entry.time}-${index}`}
              className="rounded-lg bg-surface-container-low px-3 py-2 text-xs space-y-0.5"
            >
              <p className="flex items-center gap-2 text-[11px]">
                <span className={`font-medium ${LEVEL_MARK[entry.level]}`}>
                  {t(`logs.level.${entry.level}`)}
                </span>
                <span className="text-secondary">{areaName(entry.area)}</span>
                <span className="flex-1" />
                <span className="text-secondary tabular-nums">{time(entry.time)}</span>
              </p>
              <p className="break-words [overflow-wrap:anywhere] whitespace-pre-wrap select-text">
                {entry.message}
              </p>
            </li>
          ))}
        </ul>
      )}
    </FullPage>
  );
}

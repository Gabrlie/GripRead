import { useEffect, useState } from "react";
import type { LogEntry, LogLevel } from "../../types/generated";
import { appLog } from "../../services/log";
import { copyText, system } from "../../services/system";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";

const LEVELS: [LogLevel, string][] = [
  ["error", "错误"],
  ["warn", "警告"],
  ["info", "全部"],
  ["detail", "详细"],
];

const LEVEL_MARK: Record<LogLevel, string> = {
  error: "text-error",
  warn: "text-amber-600 dark:text-amber-400",
  info: "text-secondary",
  detail: "text-secondary/70",
};

/** What each log area is called. */
const AREAS: Record<string, string> = {
  server: "服务器",
  sync: "同步",
  source: "书源",
  reader: "阅读",
  library: "书架",
  import: "导入",
  download: "下载",
  network: "网络",
  update: "更新",
  app: "应用",
};

function areaName(area: string): string {
  return AREAS[area] ?? area;
}

function time(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
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
      toast("日志是空的");
      return;
    }
    if (method === "copy") {
      await copyText(text);
      toast("日志已复制");
    } else if ((await system.share(text)) === "copied") toast("日志已复制");
  };

  return (
    <FullPage label="日志" onClose={onClose} layer={layer}>
      <section className="rounded-xl bg-surface-container-low px-4 py-3 flex items-center gap-3">
        <span className="flex-1 min-w-0">
          <span className="block text-sm">详细日志</span>
          <span className="block text-[11px] text-secondary">
            {detailUntil ? `${time(detailUntil)} 自动关闭` : "记录每个请求和步骤，一天后自动关闭"}
          </span>
        </span>
        <Switch
          aria-label="详细日志"
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
        {LEVELS.map(([value, label]) => (
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
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>
          刷新
        </Button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={() => void share("copy")}>
          复制全部
        </Button>
        <Button size="sm" variant="outline" className="flex-1" onClick={() => void share("share")}>
          分享
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 text-error"
          onClick={() =>
            void appLog.clear().then(() => {
              setEntries([]);
              toast("日志已清空");
            })
          }
        >
          清空
        </Button>
      </div>
      {areas.length > 1 && (
        <div role="group" aria-label="日志分类" className="flex items-center gap-1.5 flex-wrap">
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
              {value === null ? "所有分类" : areaName(value)}
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-secondary">没有日志。</p>
      ) : (
        <ul aria-label="日志" className="space-y-1.5">
          {shown.map((entry, index) => (
            <li
              key={`${entry.time}-${index}`}
              className="rounded-lg bg-surface-container-low px-3 py-2 text-xs space-y-0.5"
            >
              <p className="flex items-center gap-2 text-[11px]">
                <span className={`font-medium ${LEVEL_MARK[entry.level]}`}>
                  {LEVELS.find(([value]) => value === entry.level)?.[1] ?? entry.level}
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

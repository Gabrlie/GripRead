import { useMemo, useState } from "react";
import { activityWeeks, formatDuration, type ActivityCell } from "../../application/reading-time";

const LEVEL_CLASS = [
  "bg-surface-container",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary",
];
const WEEKDAYS = ["一", "", "三", "", "五", "", "日"];

/** A GitHub-style matrix of reading time per day over the last 26 weeks. */
export function ActivityMatrix({
  days,
  today,
}: {
  days: { day: string; seconds: number }[];
  today: string;
}) {
  const weeks = useMemo(() => activityWeeks(days, today), [days, today]);
  const [chosen, setChosen] = useState<ActivityCell | null>(null);
  const readDays = weeks.flat().filter((cell) => cell.seconds > 0).length;
  return (
    <section aria-labelledby="records-activity" className="space-y-2">
      <h2 id="records-activity" className="text-xs text-secondary font-medium">
        阅读活跃
        <span className="ml-2 font-normal">近半年读了 {readDays} 天</span>
      </h2>
      <div className="rounded-2xl bg-surface-container-low p-3 space-y-2">
        <div
          className="flex gap-[3px] overflow-x-auto no-scrollbar"
          role="grid"
          aria-label="阅读活跃"
        >
          <div className="flex flex-col gap-[3px] pt-4 pr-1 shrink-0">
            {WEEKDAYS.map((label, index) => (
              <span key={index} className="h-[11px] text-[8px] leading-[11px] text-secondary">
                {label}
              </span>
            ))}
          </div>
          {weeks.map((week, index) => {
            const first = week[0];
            const month =
              first && (index === 0 || first.day.slice(8) <= "07")
                ? Number(first.day.slice(5, 7))
                : null;
            return (
              <div
                key={first?.day ?? index}
                className="flex flex-col gap-[3px] shrink-0"
                role="row"
              >
                <span className="h-[13px] text-[8px] leading-[13px] text-secondary whitespace-nowrap">
                  {month ? `${month}月` : ""}
                </span>
                {week.map((cell) => (
                  <button
                    key={cell.day}
                    type="button"
                    role="gridcell"
                    aria-label={`${cell.day} ${formatDuration(cell.seconds)}`}
                    data-level={cell.level}
                    onClick={() => setChosen(cell)}
                    className={`w-[11px] h-[11px] rounded-[2px] ${LEVEL_CLASS[cell.level]} ${
                      cell.day === today ? "ring-1 ring-on-surface/60" : ""
                    } ${chosen?.day === cell.day ? "ring-2 ring-primary" : ""}`}
                  />
                ))}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-secondary">
          <span className="flex-1 min-w-0 truncate">
            {chosen
              ? `${chosen.day}：${formatDuration(chosen.seconds)}`
              : "点一格查看那天的阅读时长"}
          </span>
          <span>少</span>
          {LEVEL_CLASS.map((name, level) => (
            <span key={level} className={`w-[11px] h-[11px] rounded-[2px] ${name}`} />
          ))}
          <span>多</span>
        </div>
      </div>
    </section>
  );
}

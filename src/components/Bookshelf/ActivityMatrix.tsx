import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { activityWeeks, formatDuration, type ActivityCell } from "../../application/reading-time";
import { t } from "../../i18n";

const LEVEL_CLASS = [
  "bg-surface-container",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary",
];
/** Monday, Wednesday, Friday, and Sunday are labelled. */
const weekdays = () => [
  t("records.mon"),
  "",
  t("records.wed"),
  "",
  t("records.fri"),
  "",
  t("records.sun"),
];

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
  const scroller = useRef<HTMLDivElement>(null);
  // Today is at the right end; earlier weeks are a swipe to the left.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box) box.scrollLeft = box.scrollWidth;
  }, [weeks]);
  const readDays = weeks.flat().filter((cell) => cell.seconds > 0).length;
  return (
    <section aria-labelledby="records-activity" className="space-y-2">
      <h2 id="records-activity" className="text-xs text-secondary font-medium">
        {t("records.activity")}
        <span className="ml-2 font-normal">{t("records.readDays", { days: readDays })}</span>
      </h2>
      <div className="rounded-2xl bg-surface-container-low p-3 space-y-2">
        <div className="flex">
          {/* The weekday axis stays put while the weeks scroll. */}
          <div aria-hidden="true" className="flex flex-col gap-[3px] pt-4 pr-1.5 shrink-0">
            {weekdays().map((label, index) => (
              <span key={index} className="h-[11px] text-[8px] leading-[11px] text-secondary">
                {label}
              </span>
            ))}
          </div>
          <div ref={scroller} className="min-w-0 overflow-x-auto no-scrollbar">
            <div className="flex gap-[3px]" role="grid" aria-label={t("records.activity")}>
              {weeks.map((week, index) => {
                const first = week[0];
                const month =
                  first && (index === 0 || first.day.slice(8) <= "07")
                    ? Number(first.day.slice(5, 7))
                    : null;
                return (
                  <div
                    key={first?.day ?? index}
                    className="relative flex flex-col gap-[3px] pt-4 w-[11px] shrink-0"
                    role="row"
                  >
                    {month && (
                      <span className="absolute left-0 top-0 text-[8px] leading-[13px] text-secondary whitespace-nowrap">
                        {t("records.month", { month })}
                      </span>
                    )}
                    {week.map((cell) => (
                      <button
                        key={cell.day}
                        type="button"
                        role="gridcell"
                        aria-label={`${cell.day} ${formatDuration(cell.seconds)}`}
                        data-level={cell.level}
                        onClick={() => setChosen(cell)}
                        className={`w-[11px] h-[11px] rounded-[2px] ${LEVEL_CLASS[cell.level]} ${
                          chosen?.day === cell.day
                            ? "ring-2 ring-inset ring-primary"
                            : cell.day === today
                              ? "ring-1 ring-inset ring-on-surface/70"
                              : ""
                        }`}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-secondary">
          <span className="flex-1 min-w-0 truncate">
            {chosen ? `${chosen.day}：${formatDuration(chosen.seconds)}` : t("records.tapHint")}
          </span>
          <span>{t("records.less")}</span>
          {LEVEL_CLASS.map((name, level) => (
            <span key={level} className={`w-[11px] h-[11px] rounded-[2px] ${name}`} />
          ))}
          <span>{t("records.more")}</span>
        </div>
      </div>
    </section>
  );
}

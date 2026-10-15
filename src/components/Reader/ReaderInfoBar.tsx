import { useEffect, useState } from "react";
import type { InfoBar, InfoSlot, Margins } from "../../types/generated";
import { system } from "../../services/system";
import { formatClock, t } from "../../i18n";

export interface InfoValues {
  bookTitle: string;
  chapterTitle: string;
  /** 0–100 within the current chapter. */
  chapterProgress: number;
  /** 0–100 within the book. */
  bookProgress: number;
}

function useClock(): string {
  const format = () => formatClock(Date.now());
  const [time, setTime] = useState(format);
  useEffect(() => {
    const timer = window.setInterval(() => setTime(format()), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  return time;
}

function useBattery(enabled: boolean): number | null {
  const [level, setLevel] = useState<number | null>(() => (enabled ? system.battery() : null));
  useEffect(() => {
    if (!enabled) return;
    setLevel(system.battery());
    const timer = window.setInterval(() => setLevel(system.battery()), 60_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return level;
}

/**
 * Legado's 页眉/页脚: three slots with time, battery, titles, or progress,
 * drawn in the reading colours and inside the body margins.
 */
export function ReaderInfoBar({
  bar,
  values,
  margins,
  line,
  position,
}: {
  bar: InfoBar;
  values: InfoValues;
  margins: Margins;
  /** A divider between this bar and the body. */
  line: boolean;
  position: "header" | "footer";
}) {
  const slots = [bar.left, bar.middle, bar.right];
  const time = useClock();
  const battery = useBattery(bar.visible && slots.includes("battery"));
  if (!bar.visible) return null;
  const text = (slot: InfoSlot): string => {
    switch (slot) {
      case "time":
        return time;
      case "battery":
        return battery === null ? "" : t("reader.battery", { level: battery });
      case "chapter_title":
        return values.chapterTitle;
      case "book_title":
        return values.bookTitle;
      case "chapter_progress":
        return `${Math.round(values.chapterProgress)}%`;
      case "book_progress":
        return `${values.bookProgress.toFixed(1)}%`;
      default:
        return "";
    }
  };
  return (
    <div
      data-testid={`reader-${position}`}
      // Page turns copy the bars so the whole screen turns (page-turn.ts).
      data-reader-chrome=""
      aria-hidden="true"
      className="shrink-0 select-none"
      style={{
        paddingTop: margins.top,
        paddingBottom: margins.bottom,
        paddingLeft: margins.left,
        paddingRight: margins.right,
      }}
    >
      <div
        className={`h-6 flex items-center gap-3 text-[11px] opacity-60 tabular-nums ${line ? (position === "header" ? "border-b" : "border-t") : ""} border-current`}
      >
        <span className="flex-1 min-w-0 truncate text-left">{text(slots[0])}</span>
        <span className="shrink-0 truncate text-center">{text(slots[1])}</span>
        <span className="flex-1 min-w-0 truncate text-right">{text(slots[2])}</span>
      </div>
    </div>
  );
}

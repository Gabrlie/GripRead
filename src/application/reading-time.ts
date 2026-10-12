/** The reader's local calendar day as `YYYY-MM-DD`. */
export function localDay(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return seconds > 0 ? "不到 1 分钟" : "0 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
}

export interface ActivityCell {
  day: string;
  seconds: number;
  /** 0 for no reading, then 1–4 by time read that day. */
  level: number;
}

/** Minutes that start each activity level after 0. */
const LEVEL_MINUTES = [1, 15, 45, 90];

export function activityLevel(seconds: number): number {
  const minutes = seconds / 60;
  let level = seconds > 0 ? 1 : 0;
  for (let index = 1; index < LEVEL_MINUTES.length; index++)
    if (minutes >= LEVEL_MINUTES[index]) level = index + 1;
  return level;
}

/**
 * The days of the activity matrix as weeks (Monday first), oldest week
 * first, ending with the week of `today`; days after today are left out.
 */
export function activityWeeks(
  days: { day: string; seconds: number }[],
  today: string,
  weeks = 26,
): ActivityCell[][] {
  const seconds = new Map(days.map((item) => [item.day, item.seconds]));
  const [year, month, date] = today.split("-").map(Number);
  const end = new Date(year, month - 1, date);
  const mondayOffset = (end.getDay() + 6) % 7;
  const start = new Date(end);
  start.setDate(end.getDate() - mondayOffset - (weeks - 1) * 7);
  const result: ActivityCell[][] = [];
  for (let week = 0; week < weeks; week++) {
    const column: ActivityCell[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const cell = new Date(start);
      cell.setDate(start.getDate() + week * 7 + weekday);
      if (cell > end) break;
      const day = localDay(cell);
      const value = seconds.get(day) ?? 0;
      column.push({ day, seconds: value, level: activityLevel(value) });
    }
    result.push(column);
  }
  return result;
}

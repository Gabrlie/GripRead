import { formatDate, formatDateTime, t } from "../../i18n";

/** A publication time as the article list shows it. */
export function articleTime(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return t("rss.time.justNow");
  if (minutes < 60) return t("rss.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("rss.time.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t("rss.time.days", { count: days });
  return new Date(at).getFullYear() === new Date(now).getFullYear()
    ? formatDateTime(at, { month: "short", day: "numeric" })
    : formatDate(at);
}

/** Refresh intervals in minutes with their labels; 0 turns refreshing off. */
export const refreshIntervals = (minutes: number[]): [number, string][] =>
  minutes.map((value) => [
    value,
    value === 0
      ? t("common.off")
      : value < 60
        ? t("rss.settings.minutes", { count: value })
        : t("rss.settings.hours", { count: value / 60 }),
  ]);

/** The site name of an address, for feeds without a title. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * A picture's bytes as a blob: browsers tell raster formats from their
 * bytes, but an SVG only shows with its type.
 */
export function imageBlob(bytes: ArrayBuffer): Blob {
  const start = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  const svg = start.startsWith("<svg") || (start.startsWith("<?xml") && start.includes("<svg"));
  return new Blob([bytes], svg ? { type: "image/svg+xml" } : {});
}

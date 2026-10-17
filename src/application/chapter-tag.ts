import { formatDateTime } from "../i18n";

/**
 * An online chapter's tag (Legado's ruleToc `updateTime`) for the contents:
 * a timestamp or date shown as one in the interface language, any other
 * text as the source gave it.
 */
export function chapterTag(tag: string | null | undefined): string {
  const text = tag?.trim() ?? "";
  if (!text) return "";
  if (/^\d{10}$|^\d{13}$/.test(text)) {
    const at = Number(text) * (text.length === 10 ? 1000 : 1);
    return formatDateTime(at, dateOptions(at));
  }
  // 2024-01-02, 2024/1/2 12:30, 2024-01-02T12:30:00Z, …
  const date = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
    text,
  );
  if (date && text.length <= 25) {
    const [, year, month, day, hour, minute] = date;
    const at = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
    ).getTime();
    if (!Number.isNaN(at))
      return formatDateTime(at, hour === undefined ? dayOnly(at) : dateOptions(at));
  }
  return text;
}

function dayOnly(at: number): Intl.DateTimeFormatOptions {
  return { ...yearIfOther(at), month: "2-digit", day: "2-digit" };
}

function dateOptions(at: number): Intl.DateTimeFormatOptions {
  return { ...dayOnly(at), hour: "2-digit", minute: "2-digit" };
}

/** The year only when it is not this one, so rows stay short. */
function yearIfOther(at: number): Intl.DateTimeFormatOptions {
  return new Date(at).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" };
}

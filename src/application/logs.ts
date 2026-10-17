import { errorText, formatDateTime, t, type MessageKey } from "../i18n";
import type { LogEntry } from "../types/generated";

/**
 * A log entry in the interface language: a keyed entry is worded from
 * `log.<key>` with its params (an error among them translated by its own
 * key); others, older ones and engine traces, read as written.
 */
export function logText(entry: LogEntry): string {
  if (!entry.key) return entry.message;
  const key = `log.${entry.key}` as MessageKey;
  const params: Record<string, string> = { ...(entry.params ?? {}) };
  if (params.errorKey) {
    let nested: Record<string, string> = {};
    try {
      nested = JSON.parse(params.errorParams ?? "{}") as Record<string, string>;
    } catch {
      // A broken record keeps the error's own text.
    }
    params.error = errorText({ message: params.error ?? "", key: params.errorKey, params: nested });
  }
  const worded = t(key, params);
  // A key this version does not know reads as written.
  return worded === key ? entry.message : worded;
}

const LEVEL: Record<LogEntry["level"], string> = { detail: "D", info: "I", warn: "W", error: "E" };

/** The whole log as text in the interface language, for 复制全部 and sharing. */
export function logExport(entries: readonly LogEntry[], version: string): string {
  const lines = entries.map(
    (entry) =>
      `${formatDateTime(entry.time)} ${LEVEL[entry.level]} [${entry.area}] ${logText(entry)}`,
  );
  return [t("logs.exportTitle", { version }), "", ...lines].join("\n");
}

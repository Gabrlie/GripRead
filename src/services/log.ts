import { call } from "./transport";
import type { LogEntry, LogLevel, LogPage } from "../types/generated";

/** What an entry says, keyed so the log page shows it in its language. */
export interface LogWords {
  key: string;
  params?: Record<string, string>;
}

/** The app and the server keep the log; the browser preview and tests have none. */
function native(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || !["preview", "test"].includes(import.meta.env.MODE);
}

const kept: LogEntry[] = [];

/**
 * The app log (设置 › 日志). Rust keeps the files (the server's, in the web
 * version); in the browser preview the
 * entries live in memory so the page still works.
 */
export const appLog = {
  list: async (level: LogLevel): Promise<LogPage> =>
    native()
      ? call<LogPage>("list_log_entries", { request: { level } })
      : { entries: kept.filter((entry) => rank(entry.level) >= rank(level)), detailUntil: null },
  setDetailed: async (on: boolean): Promise<number | null> =>
    native() ? call<number | null>("set_detailed_log", { request: { on } }) : null,
  clear: async (): Promise<void> => {
    kept.length = 0;
    if (native()) await call("clear_logs");
  },
  /** Every kept entry, oldest first, for an export the page words itself. */
  allEntries: async (): Promise<LogEntry[]> =>
    native() ? call<LogEntry[]>("export_log_entries") : [...kept],
  /**
   * Never throws: logging must not break the action that failed. `words`
   * makes the entry read in the interface language; `message` is the text
   * kept beside it.
   */
  write: (level: LogLevel, area: string, message: string, words?: LogWords) => {
    const entry = { level, area, message, key: words?.key, params: words?.params };
    if (!native()) {
      kept.push({ time: Date.now(), ...entry });
      if (kept.length > 500) kept.shift();
      return;
    }
    void call("log_frontend", { request: entry }).catch(() => undefined);
  },
};

/** An error as log params, as the core writes them (`error`, `errorKey`, `errorParams`). */
export function errorParams(error: {
  message: string;
  key?: string | null;
  params?: Record<string, string> | null;
}): Record<string, string> {
  const params: Record<string, string> = { error: error.message };
  if (error.key) {
    params.errorKey = error.key;
    params.errorParams = JSON.stringify(error.params ?? {});
  }
  return params;
}

function rank(level: LogLevel): number {
  return ["detail", "info", "warn", "error"].indexOf(level);
}

/** Records uncaught errors and rejected promises from the page. */
export function captureUncaughtErrors() {
  window.addEventListener("error", (event) => {
    const message = `${event.message}${event.filename ? ` (${event.filename}:${event.lineno})` : ""}`;
    appLog.write("error", "ui", message, { key: "pageError", params: { message } });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    const text =
      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? "");
    appLog.write("error", "ui", `未处理的错误：${text}`, {
      key: "uncaught",
      params: { error: text },
    });
  });
}

/** The page or panel on top, to say where a long task happened. */
function topLayer(): string {
  const layers = document.querySelectorAll('[role="dialog"][data-open]');
  const top = layers[layers.length - 1];
  return top?.getAttribute("aria-label") ?? "主界面";
}

/** Records page work that blocked the screen for over 100 ms (详细日志). */
export function captureLongTasks() {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.duration >= 100)
          appLog.write(
            "detail",
            "ui",
            `界面卡顿 ${Math.round(entry.duration)} ms（${topLayer()}）`,
            {
              key: "longTask",
              params: { ms: String(Math.round(entry.duration)), layer: topLayer() },
            },
          );
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    // Long tasks are not reported on this WebView.
  }
}

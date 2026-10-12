import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  text: string;
  error?: boolean;
  /** One action, such as 撤销. */
  action?: { label: string; run: () => void };
}

/** How long a toast stays: confirmations briefly, failures and actions longer. */
export const TOAST_MS = 2_500;
export const LONG_TOAST_MS = 6_000;

let current: Toast | null = null;
let viewLogs: (() => void) | null = null;

/** Lets error toasts offer 查看日志; the app root registers the page. */
export function setLogViewer(open: (() => void) | null): void {
  viewLogs = open;
}
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/**
 * Shows a floating message above every page and dialog; a newer message
 * replaces it, and it hides by itself.
 */
export function toast(message: string | Omit<Toast, "id">): void {
  let value = typeof message === "string" ? { text: message } : message;
  if (value.error && !value.action && viewLogs) {
    const open = viewLogs;
    value = { ...value, action: { label: "查看日志", run: open } };
  }
  current = { ...value, id: nextId++ };
  clearTimeout(timer);
  timer = setTimeout(
    () => {
      current = null;
      notify();
    },
    value.error || value.action ? LONG_TOAST_MS : TOAST_MS,
  );
  notify();
}

export function dismissToast(): void {
  clearTimeout(timer);
  current = null;
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Renders the current toast; mounted once at the app root. */
export function Toaster() {
  const value = useSyncExternalStore(subscribe, () => current);
  if (!value) return null;
  return (
    <div
      role={value.error ? "alert" : "status"}
      className={`fixed bottom-[calc(5.5rem+var(--safe-bottom))] left-1/2 -translate-x-1/2 z-[80] max-w-[calc(100%-2rem)] w-max rounded-full shadow-md text-xs px-4 py-2 flex items-center gap-3 ${value.error ? "bg-error text-on-error" : "bg-inverse-surface text-inverse-on-surface"}`}
    >
      <span className="break-words">{value.text}</span>
      {value.action && (
        <button
          type="button"
          className="font-semibold shrink-0 underline-offset-2 hover:underline"
          onClick={() => {
            value.action?.run();
            dismissToast();
          }}
        >
          {value.action.label}
        </button>
      )}
    </div>
  );
}

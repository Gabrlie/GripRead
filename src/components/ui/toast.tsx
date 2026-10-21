import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import { describeError } from "./errors";

/**
 * The app's one way of telling the reader something: confirmations and
 * failures alike float here (pages do not print failures of their own; a
 * page whose content did not load shows `LoadFailed`).
 */
export interface Toast {
  id: number;
  text: string;
  error?: boolean;
  /** One action, such as 撤销 or 重试. */
  action?: { label: string; run: () => void };
  /**
   * Names a failure that still holds: it stays until `clearToast(key)` (a
   * newer message shows over it for a while, then it comes back).
   */
  key?: string;
}

/** How long a toast stays: confirmations briefly, failures and actions longer. */
export const TOAST_MS = 2_500;
export const LONG_TOAST_MS = 6_000;

let current: Toast | null = null;
/** Lasting failures, the newest shown again once a newer message has gone. */
let lasting: Toast[] = [];
let viewLogs: (() => void) | null = null;

/** Lets error toasts offer 查看日志; the app root registers the page. */
export function setLogViewer(open: (() => void) | null): void {
  viewLogs = open;
}
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function show(value: Toast | null) {
  current = value;
  clearTimeout(timer);
  if (value && !value.key)
    timer = setTimeout(
      () => show(lasting.at(-1) ?? null),
      value.error || value.action ? LONG_TOAST_MS : TOAST_MS,
    );
  notify();
}

/**
 * Shows a floating message above every page and dialog; a newer message
 * replaces it, and it hides by itself (a lasting one stays). The same
 * message again only stays longer.
 */
export function toast(message: string | Omit<Toast, "id">): void {
  let value = typeof message === "string" ? { text: message } : message;
  if (value.error && !value.action && viewLogs) {
    const open = viewLogs;
    value = { ...value, action: { label: t("toast.showLog"), run: open } };
  }
  const repeated =
    current?.text === value.text && !!current.error === !!value.error && current.key === value.key;
  const next = { ...value, id: repeated && current ? current.id : nextId++ };
  if (next.key) lasting = [...lasting.filter((item) => item.key !== next.key), next];
  show(next);
}

/**
 * Tells of a failure: its message, with 重试 when it can be retried (else
 * 查看日志); with `key`, it lasts until `clearToast(key)`.
 */
export function reportError(
  error: unknown,
  options: { retry?: () => void; key?: string } = {},
): void {
  toast({
    text: describeError(error),
    error: true,
    action: options.retry && { label: t("common.retry"), run: options.retry },
    key: options.key,
  });
}

/** Takes back the lasting failure `key`, once it no longer holds. */
export function clearToast(key: string): void {
  if (!lasting.some((item) => item.key === key)) return;
  lasting = lasting.filter((item) => item.key !== key);
  if (current?.key === key) show(lasting.at(-1) ?? null);
}

/** Hides the message shown (a lasting failure too; the next lasting one shows). */
export function dismissToast(): void {
  if (current?.key) lasting = lasting.filter((item) => item.key !== current?.key);
  show(lasting.at(-1) ?? null);
}

/** Forgets every message (between tests). */
export function resetToasts(): void {
  lasting = [];
  show(null);
}

/**
 * Tells of a page's or store's failure while it holds (`error` set),
 * offering `retry`; takes it back once it is gone or the page closes.
 */
export function useErrorToast(
  error: string | null | undefined,
  key: string,
  retry?: () => void,
): void {
  const again = useRef(retry);
  again.current = retry;
  const retryable = retry !== undefined;
  useEffect(() => {
    if (!error) {
      clearToast(key);
      return;
    }
    toast({
      text: describeError(error),
      error: true,
      key,
      action: retryable ? { label: t("common.retry"), run: () => again.current?.() } : undefined,
    });
  }, [error, key, retryable]);
  useEffect(() => () => clearToast(key), [key]);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Renders the current toast; mounted once at the app root. It is placed at
 * the end of the page, so an open dialog does not shut it out.
 */
export function Toaster() {
  const value = useSyncExternalStore(subscribe, () => current);
  // A live region stays put: dialogs leave those to assistive technology.
  return createPortal(
    <div aria-live="polite">{value && <ToastView value={value} />}</div>,
    document.body,
  );
}

function ToastView({ value }: { value: Toast }) {
  return (
    <div
      role={value.error ? "alert" : "status"}
      data-testid={value.key}
      className={`fixed bottom-[calc(5.5rem+var(--safe-bottom))] left-1/2 -translate-x-1/2 z-[80] max-w-[calc(100%-2rem)] w-max rounded-2xl shadow-md text-xs px-4 py-2 flex items-center gap-3 ${value.error ? "bg-error text-on-error" : "bg-inverse-surface text-inverse-on-surface"}`}
    >
      <span className="break-words">{value.text}</span>
      {value.action && (
        <button
          type="button"
          className="font-semibold shrink-0 underline-offset-2 hover:underline"
          onClick={() => {
            value.action?.run();
            // A lasting failure stays until it is resolved.
            if (!value.key) dismissToast();
          }}
        >
          {value.action.label}
        </button>
      )}
    </div>
  );
}

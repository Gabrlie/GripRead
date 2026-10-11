import { useCallback, useEffect, useState } from "react";

export interface Notice {
  text: string;
  error?: boolean;
}

/** How long a notice stays: confirmations briefly, failures long enough to read. */
export const NOTICE_MS = 2_500;
export const ERROR_NOTICE_MS = 6_000;

/**
 * An inline status message that hides by itself, so confirmations such as
 * 已保存 never linger. Showing another message restarts the timer.
 */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => setNotice(null),
      notice.error ? ERROR_NOTICE_MS : NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);
  const show = useCallback((next: Notice | string | null) => {
    setNotice(typeof next === "string" ? { text: next } : next);
  }, []);
  return [notice, show] as const;
}

export function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p
      role={notice.error ? "alert" : "status"}
      className={`rounded-lg px-3 py-2 text-xs break-words ${notice.error ? "bg-error-container text-error" : "bg-surface-container text-primary"}`}
    >
      {notice.text}
    </p>
  );
}

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Session-scoped action runner for the reader view. Results from a previous
 * book (an older session epoch) never publish errors into the current one.
 */
export function useReaderActions(bookId: string | undefined) {
  const sessionEpoch = useRef(0);
  const failedAction = useRef<(() => Promise<void>) | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useLayoutEffect(() => {
    sessionEpoch.current += 1;
    return () => {
      sessionEpoch.current += 1;
    };
  }, [bookId]);
  const run = useCallback((action: () => Promise<void>) => {
    const epoch = sessionEpoch.current;
    setActionError(null);
    failedAction.current = null;
    void action().catch((error) => {
      if (!isAbortError(error) && epoch === sessionEpoch.current) {
        failedAction.current = action;
        setActionError(String(error));
      }
    });
  }, []);
  /** Record a failure raised outside `run` together with its retry action. */
  const fail = useCallback((message: string, retry: (() => Promise<void>) | null = null) => {
    failedAction.current = retry;
    setActionError(message);
  }, []);
  const clearError = useCallback(() => {
    failedAction.current = null;
    setActionError(null);
  }, []);
  return { sessionEpoch, failedAction, actionError, run, fail, clearError };
}

export type ReaderActions = ReturnType<typeof useReaderActions>;

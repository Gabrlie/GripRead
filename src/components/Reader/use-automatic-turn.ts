import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface AutomaticTurnOptions {
  intervalSeconds: number;
  canContinue: () => boolean;
  turn: () => Promise<void>;
}

/** Runs one page turn at a time, including across pause/resume and interval changes. */
export function useAutomaticTurn({ intervalSeconds, canContinue, turn }: AutomaticTurnOptions) {
  const [session, setSession] = useState<number | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingTurn = useRef<Promise<void> | null>(null);
  const canContinueRef = useRef(canContinue);
  const turnRef = useRef(turn);
  canContinueRef.current = canContinue;
  turnRef.current = turn;

  const start = useCallback(() => {
    if (document.visibilityState !== "hidden" && canContinueRef.current()) {
      setSession(++generation.current);
    }
  }, []);
  const pause = useCallback(() => {
    // Invalidate synchronously: an exit flush must not race the next timer while
    // React is still committing the paused state.
    generation.current += 1;
    clearTimeout(timer.current);
    timer.current = undefined;
    setSession(null);
    return pendingTurn.current ?? Promise.resolve();
  }, []);

  useEffect(() => {
    if (session === null) return;
    let active = true;
    const isCurrent = () => active && generation.current === session;
    const pauseWhenUnavailable = () => void pause();
    const schedule = async () => {
      // A previous session may still be loading or animating its last page.
      await pendingTurn.current;
      if (!isCurrent()) return;
      timer.current = setTimeout(() => void turnNextPage(), Math.max(1, intervalSeconds) * 1000);
    };
    const turnNextPage = async () => {
      if (!isCurrent()) return;
      timer.current = undefined;
      if (document.visibilityState === "hidden" || !canContinueRef.current()) {
        void pause();
        return;
      }
      const operation = (async () => {
        try {
          await turnRef.current();
        } catch {
          if (isCurrent()) void pause();
        }
      })();
      pendingTurn.current = operation;
      await operation;
      if (pendingTurn.current === operation) pendingTurn.current = null;
      if (!isCurrent()) return;
      if (!canContinueRef.current()) {
        void pause();
        return;
      }
      void schedule();
    };
    window.addEventListener("blur", pauseWhenUnavailable);
    document.addEventListener("visibilitychange", pauseWhenUnavailable);
    void schedule();
    return () => {
      active = false;
      clearTimeout(timer.current);
      timer.current = undefined;
      window.removeEventListener("blur", pauseWhenUnavailable);
      document.removeEventListener("visibilitychange", pauseWhenUnavailable);
    };
  }, [intervalSeconds, pause, session]);

  return useMemo(() => ({ running: session !== null, start, pause }), [session, start, pause]);
}

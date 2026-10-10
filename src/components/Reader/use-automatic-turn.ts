import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Legado's reveal: the next page is uncovered from the top over each interval. */
export interface AutomaticReveal {
  /** Covers the screen with the current page and turns underneath it. */
  begin: () => void;
  progress: (fraction: number) => void;
  end: () => void;
}

interface AutomaticTurnOptions {
  intervalSeconds: number;
  canContinue: () => boolean;
  turn: () => Promise<void>;
  scroll?: { speed: number; advance: (pixels: number) => void };
  reveal?: AutomaticReveal;
}

/** Runs one page turn at a time, including across pause/resume and interval changes. */
export function useAutomaticTurn({
  intervalSeconds,
  canContinue,
  turn,
  scroll,
  reveal,
}: AutomaticTurnOptions) {
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const [session, setSession] = useState<number | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingTurn = useRef<Promise<void> | null>(null);
  const animationFrame = useRef(0);
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;
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
    cancelAnimationFrame(animationFrame.current);
    revealRef.current?.end();
    setSession(null);
    return pendingTurn.current ?? Promise.resolve();
  }, []);

  useEffect(() => {
    if (session === null) return;
    let active = true;
    const isCurrent = () => active && generation.current === session;
    const pauseWhenUnavailable = () => void pause();
    let previousFrame: number | null = null;
    let fractionalPixels = 0;
    const scrollFrame = (time: number) => {
      if (!isCurrent()) return;
      if (document.visibilityState === "hidden" || !canContinueRef.current()) {
        void pause();
        return;
      }
      if (previousFrame !== null && scrollRef.current) {
        // WebKit can round each scrollTop assignment to a whole CSS pixel.
        // Carry sub-pixel movement across frames instead of losing it at low speeds.
        fractionalPixels += (Math.min(100, time - previousFrame) / 1000) * scrollRef.current.speed;
        const pixels = Math.floor(fractionalPixels);
        fractionalPixels -= pixels;
        if (pixels) scrollRef.current.advance(pixels);
      }
      previousFrame = time;
      animationFrame.current = requestAnimationFrame(scrollFrame);
    };
    const schedule = async () => {
      // A previous session may still be loading or animating its last page.
      await pendingTurn.current;
      if (!isCurrent()) return;
      if (revealRef.current) {
        void revealNextPage();
        return;
      }
      timer.current = setTimeout(() => void turnNextPage(), Math.max(1, intervalSeconds) * 1000);
    };
    // The page turns at once beneath a copy of the current page, which is
    // then clipped away from the top over the interval.
    const revealNextPage = async () => {
      const current = revealRef.current;
      if (!isCurrent() || !current) return;
      if (document.visibilityState === "hidden" || !canContinueRef.current()) {
        void pause();
        return;
      }
      current.begin();
      const operation = (async () => {
        try {
          await turnRef.current();
          return true;
        } catch {
          return false;
        }
      })();
      pendingTurn.current = operation.then(() => undefined);
      const turned = await operation;
      pendingTurn.current = null;
      if (!isCurrent()) return;
      if (!turned) {
        current.end();
        void pause();
        return;
      }
      const duration = Math.max(1, intervalSeconds) * 1000;
      let begin: number | null = null;
      const frame = (time: number) => {
        if (!isCurrent()) return;
        if (document.visibilityState === "hidden" || !canContinueRef.current()) {
          void pause();
          return;
        }
        begin ??= time;
        const fraction = Math.min(1, (time - begin) / duration);
        current.progress(fraction);
        if (fraction < 1) {
          animationFrame.current = requestAnimationFrame(frame);
          return;
        }
        current.end();
        void schedule();
      };
      animationFrame.current = requestAnimationFrame(frame);
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
    if (scroll) animationFrame.current = requestAnimationFrame(scrollFrame);
    else void schedule();
    return () => {
      active = false;
      clearTimeout(timer.current);
      cancelAnimationFrame(animationFrame.current);
      timer.current = undefined;
      window.removeEventListener("blur", pauseWhenUnavailable);
      document.removeEventListener("visibilitychange", pauseWhenUnavailable);
    };
  }, [intervalSeconds, pause, session, Boolean(scroll), Boolean(reveal)]);

  return useMemo(() => ({ running: session !== null, start, pause }), [session, start, pause]);
}

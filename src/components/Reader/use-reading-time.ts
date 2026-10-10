import { useEffect, useRef } from "react";
import type { LibraryService } from "../../services/contracts";
import { localDay } from "../../application/reading-time";

/** Reading pauses count only this long after the last touch, key, or turn. */
export const IDLE_AFTER_MS = 5 * 60_000;
const TICK_MS = 15_000;
const SAVE_EVERY_S = 60;

/**
 * Records reading time for the open book while the page is visible and the
 * reader is active (recent input, or automatic turning / read-aloud via
 * `busy`). Time is saved each minute and when the reader closes or hides.
 */
export function useReadingTime(
  bookId: string | undefined,
  service: Pick<LibraryService, "addReadingTime">,
  busy: boolean,
  now: () => number = Date.now,
) {
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (!bookId) return;
    let last = now();
    let activity = last;
    let pending = 0;
    const save = () => {
      const seconds = Math.round(pending);
      pending = 0;
      if (seconds > 0)
        void service.addReadingTime(bookId, localDay(), seconds).catch(() => undefined);
    };
    const count = () => {
      const at = now();
      const visible = document.visibilityState !== "hidden";
      if (visible && (busyRef.current || at - activity < IDLE_AFTER_MS))
        pending += Math.min(at - last, TICK_MS * 2) / 1000;
      last = at;
      if (pending >= SAVE_EVERY_S) save();
    };
    const active = () => {
      count();
      activity = now();
    };
    const hidden = () => {
      count();
      if (document.visibilityState === "hidden") save();
    };
    const timer = window.setInterval(count, TICK_MS);
    const events = ["pointerdown", "keydown", "wheel", "gripread-volume-key"];
    events.forEach((name) => window.addEventListener(name, active, { passive: true }));
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.clearInterval(timer);
      events.forEach((name) => window.removeEventListener(name, active));
      document.removeEventListener("visibilitychange", hidden);
      count();
      save();
    };
  }, [bookId, service, now]);
}

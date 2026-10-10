// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_AFTER_MS, useReadingTime } from "./use-reading-time";

afterEach(() => vi.useRealTimers());

describe("reading time", () => {
  it("counts active reading, pauses when idle, and saves on close", () => {
    vi.useFakeTimers();
    const addReadingTime = vi.fn(
      async (_book: string, _day: string, _seconds: number) => undefined,
    );
    const total = () => addReadingTime.mock.calls.reduce((sum, call) => sum + call[2], 0);
    const { unmount } = renderHook(() => useReadingTime("book", { addReadingTime }, false));
    vi.advanceTimersByTime(60_000);
    expect(addReadingTime).toHaveBeenCalledWith("book", expect.any(String), 60);
    // Counting stops once the reader has been idle for five minutes (the last
    // counted tick is at 285 s), and nothing more accrues while idle.
    vi.advanceTimersByTime(IDLE_AFTER_MS + 120_000);
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(30_000);
    unmount();
    expect(total()).toBe(285 + 30);
  });

  it("keeps counting while automatic turning or read-aloud runs", () => {
    vi.useFakeTimers();
    const addReadingTime = vi.fn(
      async (_book: string, _day: string, _seconds: number) => undefined,
    );
    const { unmount } = renderHook(() => useReadingTime("book", { addReadingTime }, true));
    vi.advanceTimersByTime(IDLE_AFTER_MS * 2);
    unmount();
    expect(addReadingTime.mock.calls.reduce((sum, call) => sum + call[2], 0)).toBe(600);
  });
});

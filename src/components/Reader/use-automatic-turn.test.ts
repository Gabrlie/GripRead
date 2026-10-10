// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutomaticTurn } from "./use-automatic-turn";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function advance(milliseconds: number) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("automatic page turning", () => {
  it("scrolls at the selected speed and discards elapsed background time", async () => {
    let scrollTop = 0;
    const advancePixels = vi.fn((pixels: number) => {
      scrollTop = Math.floor(scrollTop + pixels);
    });
    const { result } = renderHook(() =>
      useAutomaticTurn({
        intervalSeconds: 8,
        canContinue: () => true,
        turn: vi.fn(),
        scroll: { speed: 40, advance: advancePixels },
      }),
    );
    await advance(1000);
    expect(advancePixels).not.toHaveBeenCalled();
    await act(() => result.current.start());
    await advance(1000);
    const distance = advancePixels.mock.calls.reduce((sum, [pixels]) => sum + Number(pixels), 0);
    expect(distance).toBeGreaterThan(35);
    expect(distance).toBeLessThanOrEqual(40);
    expect(scrollTop).toBeGreaterThan(35);
    await act(() => window.dispatchEvent(new Event("blur")));
    const count = advancePixels.mock.calls.length;
    await advance(60_000);
    expect(advancePixels).toHaveBeenCalledTimes(count);
    expect(result.current.running).toBe(false);
    advancePixels.mockClear();
    await act(() => result.current.start());
    await advance(100);
    expect(
      advancePixels.mock.calls.reduce((sum, [pixels]) => sum + Number(pixels), 0),
    ).toBeLessThan(5);
  });
  it("starts explicitly and waits a complete interval after cross-window loading", async () => {
    const loading = deferred();
    const turn = vi.fn().mockReturnValueOnce(loading.promise).mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAutomaticTurn({ intervalSeconds: 8, canContinue: () => true, turn }),
    );
    await advance(80_000);
    expect(turn).not.toHaveBeenCalled();
    await act(() => result.current.start());
    await advance(7_999);
    expect(turn).not.toHaveBeenCalled();
    await advance(1);
    expect(turn).toHaveBeenCalledTimes(1);
    await advance(80_000);
    expect(turn).toHaveBeenCalledTimes(1);
    await act(() => loading.resolve());
    await advance(7_999);
    expect(turn).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(turn).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a previous turn after a rapid pause and resume", async () => {
    const loading = deferred();
    const turn = vi.fn().mockReturnValueOnce(loading.promise).mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAutomaticTurn({ intervalSeconds: 2, canContinue: () => true, turn }),
    );
    await act(() => result.current.start());
    await advance(2_000);
    await act(() => {
      void result.current.pause();
      result.current.start();
    });
    await advance(20_000);
    expect(turn).toHaveBeenCalledTimes(1);
    await act(() => loading.resolve());
    await advance(2_000);
    expect(turn).toHaveBeenCalledTimes(2);
  });

  it("waits for a pending turn when the interval changes", async () => {
    const loading = deferred();
    const turn = vi.fn().mockReturnValueOnce(loading.promise).mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ intervalSeconds }) => useAutomaticTurn({ intervalSeconds, canContinue: () => true, turn }),
      { initialProps: { intervalSeconds: 8 } },
    );
    await act(() => result.current.start());
    await advance(8_000);
    rerender({ intervalSeconds: 2 });
    await advance(20_000);
    expect(turn).toHaveBeenCalledTimes(1);
    await act(() => loading.resolve());
    await advance(2_000);
    expect(turn).toHaveBeenCalledTimes(2);
  });

  it("cancels timers immediately and allows exit to await an already running turn", async () => {
    const loading = deferred();
    const turn = vi.fn(() => loading.promise);
    const { result } = renderHook(() =>
      useAutomaticTurn({ intervalSeconds: 2, canContinue: () => true, turn }),
    );
    await act(() => result.current.start());
    act(() => {
      void result.current.pause();
      vi.advanceTimersByTime(2_000);
    });
    expect(turn).not.toHaveBeenCalled();
    await act(() => result.current.start());
    await advance(2_000);
    let drained = false;
    act(() => {
      void result.current.pause().then(() => {
        drained = true;
      });
    });
    await advance(20_000);
    expect(drained).toBe(false);
    await act(() => loading.resolve());
    expect(drained).toBe(true);
    await advance(20_000);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it.each(["blur", "visibilitychange"])("pauses on %s until explicitly resumed", async (event) => {
    const turn = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useAutomaticTurn({ intervalSeconds: 2, canContinue: () => true, turn }),
    );
    await act(() => result.current.start());
    act(() => (event === "blur" ? window : document).dispatchEvent(new Event(event)));
    await advance(20_000);
    expect(result.current.running).toBe(false);
    expect(turn).not.toHaveBeenCalled();
    await act(() => result.current.start());
    await advance(2_000);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it("stops after failures and on the final page", async () => {
    let hasAfter = true;
    const turn = vi
      .fn()
      .mockRejectedValueOnce(new Error("window failed"))
      .mockImplementation(() => {
        hasAfter = false;
        return Promise.resolve();
      });
    const { result } = renderHook(() =>
      useAutomaticTurn({ intervalSeconds: 2, canContinue: () => hasAfter, turn }),
    );
    await act(() => result.current.start());
    await advance(20_000);
    expect(result.current.running).toBe(false);
    expect(turn).toHaveBeenCalledTimes(1);
    await act(() => result.current.start());
    await advance(20_000);
    expect(result.current.running).toBe(false);
    expect(turn).toHaveBeenCalledTimes(2);
    await act(() => result.current.start());
    expect(result.current.running).toBe(false);
  });

  it("discards pending callbacks on unmount and reopens paused", async () => {
    const loading = deferred();
    const turn = vi.fn(() => loading.promise);
    const options = { intervalSeconds: 2, canContinue: () => true, turn };
    const first = renderHook(() => useAutomaticTurn(options));
    await act(() => first.result.current.start());
    await advance(2_000);
    first.unmount();
    await act(() => loading.resolve());
    const second = renderHook(() => useAutomaticTurn(options));
    await advance(20_000);
    expect(second.result.current.running).toBe(false);
    expect(turn).toHaveBeenCalledTimes(1);
  });
});

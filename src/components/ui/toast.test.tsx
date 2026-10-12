// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOAST_MS, Toaster, dismissToast, setLogViewer, toast } from "./toast";

afterEach(() => {
  act(() => dismissToast());
  setLogViewer(null);
  cleanup();
  vi.useRealTimers();
});

describe("toast", () => {
  it("floats one message that hides by itself and runs its action", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => toast("已保存"));
    expect(screen.getByRole("status").textContent).toBe("已保存");
    act(() => vi.advanceTimersByTime(TOAST_MS + 10));
    expect(screen.queryByRole("status")).toBeNull();
    const undo = vi.fn();
    act(() => toast({ text: "已移到回收站：书", action: { label: "撤销", run: undo } }));
    act(() => screen.getByRole("button", { name: "撤销" }).click());
    expect(undo).toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers 查看日志 on failures only", () => {
    const open = vi.fn();
    setLogViewer(open);
    render(<Toaster />);
    act(() => toast("已保存"));
    expect(screen.queryByRole("button", { name: "查看日志" })).toBeNull();
    act(() => toast({ text: "换源失败", error: true }));
    act(() => screen.getByRole("button", { name: "查看日志" }).click());
    expect(open).toHaveBeenCalledOnce();
  });
});

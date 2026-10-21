// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LONG_TOAST_MS,
  TOAST_MS,
  Toaster,
  clearToast,
  dismissToast,
  setLogViewer,
  toast,
} from "./toast";

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

describe("telling of failures", () => {
  it("leaves no page printing failures of its own", () => {
    const sources = import.meta.glob(["../../**/*.tsx", "!../../**/*.test.tsx"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const printing = Object.entries(sources)
      .filter(([path, text]) => !path.endsWith("/ui/toast.tsx") && text.includes('role="alert"'))
      .map(([path]) => path);
    expect(printing).toEqual([]);
  });

  it("keeps a lasting failure until it is resolved, under newer messages", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => toast({ text: "进度没有保存", error: true, key: "unsaved" }));
    act(() => toast("已保存"));
    expect(screen.getByRole("status").textContent).toBe("已保存");
    act(() => vi.advanceTimersByTime(TOAST_MS + 10));
    expect(screen.getByRole("alert").textContent).toContain("进度没有保存");
    act(() => vi.advanceTimersByTime(LONG_TOAST_MS * 2));
    expect(screen.getByRole("alert").textContent).toContain("进度没有保存");
    act(() => clearToast("unsaved"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the same message once, staying longer", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => toast({ text: "读取失败", error: true }));
    act(() => vi.advanceTimersByTime(LONG_TOAST_MS - 1000));
    act(() => toast({ text: "读取失败", error: true }));
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

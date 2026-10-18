// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exit = vi.hoisted(() => ({ requestExit: vi.fn(() => false) }));
vi.mock("../../services/lifecycle", () => exit);

import { DISCLAIMER_VERSION, DisclaimerDialog, DisclaimerPrompt } from "./Disclaimer";

describe("Disclaimer", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    exit.requestExit.mockClear();
  });

  it("asks until agreed, then stays away", () => {
    const { unmount } = render(<DisclaimerPrompt />);
    expect(screen.getByText("免责声明")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByText("免责声明")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "同意" }));
    expect(screen.queryByText("免责声明")).toBeNull();
    expect(localStorage.getItem("gripread.disclaimer")).toBe(String(DISCLAIMER_VERSION));
    unmount();
    render(<DisclaimerPrompt />);
    expect(screen.queryByText("免责声明")).toBeNull();
  });

  it("asks again when the text has changed", () => {
    localStorage.setItem("gripread.disclaimer", String(DISCLAIMER_VERSION - 1));
    render(<DisclaimerPrompt />);
    expect(screen.getByText("免责声明")).toBeTruthy();
  });

  it("quits on 不同意, and where it cannot, says to close the page", () => {
    render(<DisclaimerPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "不同意" }));
    expect(exit.requestExit).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("关闭此页面");
    expect(screen.getByText("免责声明")).toBeTruthy();
    expect(localStorage.getItem("gripread.disclaimer")).toBeNull();
  });

  it("shows the same text from 关于, closable", () => {
    const onClose = vi.fn();
    render(<DisclaimerDialog onClose={onClose} />);
    expect(screen.getByText(/不内置书源/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]!);
    expect(onClose).toHaveBeenCalled();
  });
});

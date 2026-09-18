// @vitest-environment jsdom
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Header } from "./Header";
afterEach(cleanup);
describe("shelf menu", () => {
  it("keeps deferred actions disabled and returns focus after Escape", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    render(<Header title="书架" onUpdateToc={refresh} />);
    const trigger = screen.getByRole("button", { name: "更多选项" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(
      (await screen.findByRole("menuitem", { name: "远程书籍 · 未开放" })).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("menuitem", { name: "刷新书架" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Header } from "./Header";
afterEach(cleanup);
describe("more menu", () => {
  it("runs the chosen row, shows its detail, and returns focus after Escape", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    const layout = vi.fn();
    render(
      <Header
        title="书架"
        menuItems={[
          { icon: "sync", label: "刷新书架", onSelect: refresh },
          { icon: "grid_view", label: "书架布局", detail: "列表", onSelect: layout },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "更多选项" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByText("列表")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "刷新书架" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(layout).not.toHaveBeenCalled();
  });
});

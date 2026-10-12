// @vitest-environment jsdom
import React from "react";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionView } from "./Subscription/SubscriptionView";

afterEach(cleanup);
describe("deferred page boundaries", () => {
  it("keeps subscription controls without inventing feeds, articles or favorites", async () => {
    render(<SubscriptionView />);
    expect(screen.getByRole("region", { name: "订阅频道" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "订阅文章" })).toBeTruthy();
    for (const control of [...screen.getAllByRole("button"), ...screen.getAllByRole("tab")]) {
      expect(
        (control as HTMLButtonElement).disabled || control.getAttribute("aria-disabled") === "true",
      ).toBe(true);
      await userEvent.click(control);
    }
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/已同步|已成功|已收藏/)).toBeNull();
  });
});

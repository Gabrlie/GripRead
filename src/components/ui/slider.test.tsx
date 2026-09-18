// @vitest-environment jsdom
import React, { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Slider } from "./slider";

beforeEach(() => {
  // Base UI calculates the thumb's inset from actual control geometry.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = this.dataset.slot === "slider-thumb" ? 12 : 200;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 12,
      width,
      height: 12,
      toJSON() {},
    };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("single reading progress slider", () => {
  it("renders one thumb and commits keyboard navigation", async () => {
    const commit = vi.fn();
    function Host() {
      const [value, setValue] = useState<number | readonly number[]>(30);
      return (
        <Slider
          aria-label="阅读进度"
          value={value}
          onValueChange={setValue}
          onValueCommitted={commit}
        />
      );
    }
    render(<Host />);
    const sliders = await screen.findAllByRole("slider");
    expect(sliders).toHaveLength(1);
    expect(sliders[0].getAttribute("aria-valuenow")).toBe("30");
    fireEvent.keyDown(sliders[0], { key: "ArrowRight" });
    fireEvent.keyUp(sliders[0], { key: "ArrowRight" });
    expect(sliders[0].getAttribute("aria-valuenow")).toBe("31");
    expect(commit).toHaveBeenCalledWith(31, expect.anything());
  });
});

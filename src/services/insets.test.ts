// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applySystemInsets } from "./insets";

const root = document.documentElement.style;
afterEach(() => {
  for (const side of ["top", "right", "bottom", "left"]) root.removeProperty(`--safe-${side}`);
  delete (window as Window & { GripReadInsets?: unknown }).GripReadInsets;
});

describe("system insets", () => {
  it("publishes native insets and follows later changes", () => {
    let value = '{"top":24,"right":0,"bottom":16,"left":0}';
    Object.assign(window, { GripReadInsets: { get: () => value } });
    const dispose = applySystemInsets();
    expect(root.getPropertyValue("--safe-top")).toBe("24px");
    expect(root.getPropertyValue("--safe-bottom")).toBe("16px");
    value = '{"top":0,"right":32,"bottom":16,"left":0}';
    window.dispatchEvent(new Event("gripread-insets"));
    expect(root.getPropertyValue("--safe-top")).toBe("0px");
    expect(root.getPropertyValue("--safe-right")).toBe("32px");
    dispose();
  });

  it("leaves the env() fallback in place without a bridge", () => {
    applySystemInsets()();
    expect(root.getPropertyValue("--safe-top")).toBe("");
  });
});

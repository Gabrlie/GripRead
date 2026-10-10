import { describe, expect, it } from "vitest";
import { canShowSpread } from "./use-reader-layout";

describe("double-page fit", () => {
  it("shows spreads on wide screens and on landscape phones", () => {
    expect(canShowSpread(1280, 800)).toBe(true);
    expect(canShowSpread(915, 412)).toBe(true);
    expect(canShowSpread(780, 360)).toBe(true);
    expect(canShowSpread(412, 915)).toBe(false);
    expect(canShowSpread(560, 400)).toBe(false);
    expect(canShowSpread(820, 1180)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { contrast, parseHex, stylePalette } from "./theme-colors";

const rgb = (value: string) => value.split(" ").map(Number) as [number, number, number];

describe("自定义界面样式的配色", () => {
  const style = {
    id: "s",
    name: "海",
    primary: "#4a6fa5",
    paper: null,
    text: null,
    secondary: null,
  };

  it("derives readable day and night colours from the main colour", () => {
    for (const dark of [false, true]) {
      const palette = stylePalette(style, dark);
      const page = rgb(palette["--color-surface-rgb"]);
      expect(contrast(rgb(palette["--color-on-surface-rgb"]), page)).toBeGreaterThanOrEqual(7);
      expect(contrast(rgb(palette["--color-secondary-rgb"]), page)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(palette["--color-primary-rgb"]), page)).toBeGreaterThanOrEqual(3);
    }
    // Night pages are dark, day pages light.
    expect(contrast(rgb(stylePalette(style, true)["--color-surface-rgb"]), [0, 0, 0])).toBeLessThan(
      2,
    );
  });

  it("uses colours set by hand by day and leaves OLED black alone", () => {
    const set = { ...style, paper: "#fffaf0", text: "#202020", secondary: "#777777" };
    const day = stylePalette(set, false);
    expect(day["--color-surface-rgb"]).toBe("255 250 240");
    expect(day["--color-on-surface-rgb"]).toBe("32 32 32");
    expect(day["--color-secondary-rgb"]).toBe("119 119 119");
    const oled = stylePalette(set, true, true);
    expect(oled["--color-surface-rgb"]).toBeUndefined();
    expect(oled["--color-primary-rgb"]).toBeDefined();
    expect(parseHex("#12345")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { curlGeometry, glyphLefts, type LaidGlyph } from "./curl";

const finite = (point: { x: number; y: number }) =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

describe("page curl geometry", () => {
  it("produces finite points from the corner itself to beyond the opposite edge", () => {
    const corner = { x: 400, y: 700 };
    for (const touch of [
      { x: 400, y: 700 },
      { x: 380, y: 690 },
      { x: 200, y: 600 },
      { x: 0, y: 700 },
      { x: -400, y: 700 },
    ]) {
      const g = curlGeometry(touch, corner, 400);
      for (const point of [g.control1, g.control2, g.start1, g.start2, g.end1, g.end2])
        expect(finite(point)).toBe(true);
    }
  });

  it("keeps the fold on the page when a touch would tear it past the spine", () => {
    const g = curlGeometry({ x: 300, y: 100 }, { x: 400, y: 700 }, 400);
    expect(g.start1.x).toBeGreaterThanOrEqual(-0.001);
    expect(g.start1.x).toBeLessThanOrEqual(400.001);
    expect(g.touchToCorner).toBeCloseTo(Math.hypot(g.touch.x - 400, g.touch.y - 700));
  });

  it("mirrors the fold for a top corner", () => {
    const bottom = curlGeometry({ x: 300, y: 650 }, { x: 400, y: 700 }, 400);
    const top = curlGeometry({ x: 300, y: 50 }, { x: 400, y: 0 }, 400);
    expect(top.control1.x).toBeCloseTo(bottom.control1.x);
    expect(top.control2.y).toBeCloseTo(700 - bottom.control2.y);
  });
});

describe("glyph placement", () => {
  // Boxes measured in Chromium: a 20px font, 1px letter spacing, and 1.5px of
  // justification after each wide character and before one after a quote.
  const glyph = (character: string, left: number, width: number, advance = 20): LaidGlyph => ({
    character,
    line: "0:0",
    left,
    top: 0,
    width,
    height: 30,
    advance,
    spacing: 1,
    tabular: false,
  });

  it("starts a glyph after the space justification put in front of it", () => {
    const line = [
      glyph("是", 0, 22.5),
      glyph("“", 22.5, 7.66, 6.64),
      glyph("先", 30.16, 24),
      glyph("生", 54.16, 22.5),
      glyph("”", 76.66, 7.66, 6.64),
      glyph("他", 84.32, 22.5),
    ];
    const lefts = glyphLefts(line);
    expect(lefts[0]).toBe(0);
    expect(lefts[2]).toBeCloseTo(31.66);
    expect(lefts[3]).toBe(54.16);
    // The line's last character has no widening after it.
    expect(lefts[5]).toBeCloseTo(85.82);
  });

  it("leaves unjustified lines and compressed punctuation as laid out", () => {
    const lefts = glyphLefts([glyph("问", 0, 21), glyph("。", 21, 11), glyph("道", 32, 21)]);
    expect(lefts).toEqual([0, 21, 32]);
  });
});

import { describe, expect, it } from "vitest";
import { curlGeometry } from "./curl";

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

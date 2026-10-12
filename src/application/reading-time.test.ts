import { describe, expect, it } from "vitest";
import { activityLevel, activityWeeks } from "./reading-time";

describe("activity matrix", () => {
  it("lays out 26 Monday-first weeks ending today, with levels by minutes read", () => {
    // 2026-10-12 is a Monday.
    const weeks = activityWeeks(
      [
        { day: "2026-10-12", seconds: 100 * 60 },
        { day: "2026-10-05", seconds: 20 * 60 },
      ],
      "2026-10-12",
    );
    expect(weeks).toHaveLength(26);
    expect(weeks.at(-1)).toEqual([{ day: "2026-10-12", seconds: 6000, level: 4 }]);
    expect(weeks.at(-2)?.[0]).toEqual({ day: "2026-10-05", seconds: 1200, level: 2 });
    expect(weeks[0][0].day).toBe("2026-04-20");
    expect(weeks.slice(0, -1).every((week) => week.length === 7)).toBe(true);
    expect([0, 30, 60 * 15, 60 * 45, 60 * 90].map(activityLevel)).toEqual([0, 1, 2, 3, 4]);
  });
});

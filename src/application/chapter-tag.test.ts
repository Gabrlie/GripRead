import { describe, expect, it } from "vitest";
import { chapterTag } from "./chapter-tag";

describe("chapter tags", () => {
  it("read dates as dates and leave other text as written", () => {
    expect(chapterTag("")).toBe("");
    expect(chapterTag("更新于昨天")).toBe("更新于昨天");
    const year = new Date().getFullYear();
    expect(chapterTag(`${year}-03-04`)).toMatch(/03.04|3.4/);
    expect(chapterTag("2001-03-04 05:06")).toMatch(/2001/);
    expect(chapterTag(String(Date.UTC(2021, 2, 4, 12)))).toMatch(/2021/);
    expect(chapterTag(String(Date.UTC(2021, 2, 4, 12) / 1000))).toMatch(/2021/);
  });
});

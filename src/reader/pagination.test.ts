import { describe, expect, it } from "vitest";

import { paginateText } from "./pagination";

describe("paginateText", () => {
  it("does not split an emoji surrogate pair", () => {
    const pages = paginateText("ab😀cd", 10, 3);
    expect(pages.map((page) => page.text)).toEqual(["ab", "😀c", "d"]);
    expect(pages[1]).toMatchObject({ startOffset: 12, endOffset: 15 });
  });

  it("keeps adjacent page offsets contiguous", () => {
    const pages = paginateText("一二三四五", 0, 2);
    expect(pages.at(-1)?.hasAfter).toBe(false);
    for (let index = 1; index < pages.length; index += 1) {
      expect(pages[index - 1].endOffset).toBe(pages[index].startOffset);
    }
  });

  it("rejects a non-positive page budget", () => {
    expect(() => paginateText("text", 0, 0)).toThrow(RangeError);
  });
});

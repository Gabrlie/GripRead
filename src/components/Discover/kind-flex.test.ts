import { describe, expect, it } from "vitest";
import { kindFlex } from "./DiscoverView";

describe("发现分类的宽度", () => {
  it("leaves room for the gaps so four quarters share a row", () => {
    const quarter = kindFlex({
      title: "日榜",
      url: "/r",
      style: { layout_flexBasisPercent: 0.25, layout_flexGrow: 1 },
    });
    expect(quarter).toEqual({ flexBasis: "calc(25% - 4.50px)", flexGrow: 1 });
    // Four bases and three 6px gaps fill exactly one row.
    expect(4 * 4.5).toBe(3 * 6);
    expect(kindFlex({ title: "标题", url: null, style: { layout_flexBasisPercent: 1 } })).toEqual({
      flexBasis: "100%",
    });
    expect(kindFlex({ title: "无样式", url: "/x", style: null })).toEqual({});
  });
});

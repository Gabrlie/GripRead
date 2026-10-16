import { describe, expect, it } from "vitest";
import { translationDeclarations, translationStyleSheet } from "./translation";

describe("自定义译文样式", () => {
  it("keeps declarations and drops selectors, blocks, and at-rules", () => {
    expect(translationDeclarations("color: #8a6d3b;\n font-size: 0.9em")).toBe(
      "color: #8a6d3b; font-size: 0.9em",
    );
    expect(
      translationDeclarations("body { display: none } @import url(x); /* note */ opacity: .5"),
    ).toBe("opacity: .5");
    expect(translationDeclarations("color: red</style><script>")).toBe("");
    expect(translationStyleSheet("")).toBe("");
    expect(translationStyleSheet("color: red")).toBe(
      '.reader-screen[data-translation-style="custom"] .reader-prose > .reader-paragraph[data-translated] { color: red; }',
    );
  });
});

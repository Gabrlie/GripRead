// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { continuesLine, renderReaderText } from "./render";

function render(text: string, continued = false, highlight?: { start: number; end: number }) {
  const container = document.createElement("div");
  renderReaderText(container, text, { continued, highlight });
  return container;
}

describe("renderReaderText", () => {
  it("keeps textContent equal to the page slice across blank lines and emoji", () => {
    const text = "第一段😀\n\n\n第二段 with spaces  \n";
    const container = render(text);
    expect(container.textContent).toBe(text);
    const paragraphs = Array.from(container.querySelectorAll("p"));
    expect(paragraphs.map((p) => p.textContent)).toEqual([
      "第一段😀",
      "",
      "",
      "第二段 with spaces  ",
    ]);
    expect(paragraphs.filter((p) => p.dataset.blank)).toHaveLength(2);
  });

  it("marks only a continued first line and skips an empty continuation", () => {
    const continued = render("尾部\n下一段", true);
    const [first, second] = Array.from(continued.querySelectorAll("p"));
    expect(first.dataset.continued).toBe("true");
    expect(second.dataset.continued).toBeUndefined();

    const atBreak = render("\n下一段", true);
    expect(atBreak.querySelectorAll("p")).toHaveLength(1);
    expect(atBreak.textContent).toBe("\n下一段");
  });

  it("splits a highlight across paragraphs", () => {
    const container = render("abc\ndef", false, { start: 2, end: 6 });
    expect(Array.from(container.querySelectorAll("mark")).map((m) => m.textContent)).toEqual([
      "c",
      "de",
    ]);
    expect(container.textContent).toBe("abc\ndef");
  });

  it("detects continuation from the preceding character", () => {
    expect(continuesLine("ab\ncd", 3, true)).toBe(false);
    expect(continuesLine("ab\ncd", 1, false)).toBe(true);
    expect(continuesLine("ab", 0, true)).toBe(true);
  });
});

describe("DomReaderMeasurer with paragraph layout", () => {
  it("covers a window without loss, repetition, or indenting continued lines", async () => {
    const { DomReaderMeasurer } = await import("./pagination");
    const element = document.createElement("div");
    document.body.append(element);
    const lineWidth = 10;
    const lineHeight = 10;
    const pageHeight = 30;
    // A deterministic layout: every paragraph wraps each 10 UTF-16 units.
    const layout = () => {
      let top = 0;
      const boxes = new Map<Element, { top: number; bottom: number }>();
      for (const child of Array.from(element.children)) {
        if (child.tagName !== "P") continue;
        const lines = Math.max(1, Math.ceil((child.textContent ?? "").length / lineWidth));
        boxes.set(child, { top, bottom: top + lines * lineHeight });
        top += lines * lineHeight;
      }
      return { boxes, height: top };
    };
    Object.defineProperty(element, "clientHeight", { get: () => pageHeight });
    Object.defineProperty(element, "clientWidth", { get: () => 100 });
    Object.defineProperty(element, "scrollHeight", { get: () => layout().height });
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this === element)
        return { top: 0, bottom: pageHeight, height: pageHeight, width: 100 } as DOMRect;
      const box = layout().boxes.get(this);
      if (box)
        return {
          top: box.top,
          bottom: box.bottom,
          height: box.bottom - box.top,
          width: 100,
        } as DOMRect;
      return original.call(this);
    };
    try {
      const text = "x".repeat(25) + "\n\n" + "😀".repeat(12) + "\nend";
      const measurer = new DomReaderMeasurer(element);
      const pages = measurer.measure({
        bookId: "b",
        resourceId: "r",
        contentVersion: "v",
        text,
        startOffset: 0,
        endOffset: text.length,
        totalLength: text.length,
        hasBefore: false,
        hasAfter: false,
        locator: {
          bookId: "b",
          contentVersion: "v",
          resourceId: "r",
          offset: 0,
          contextBefore: "",
          contextAfter: "",
        },
      });
      expect(pages.map((page) => page.text).join("")).toBe(text);
      for (let index = 1; index < pages.length; index += 1) {
        expect(pages[index].startOffset).toBe(pages[index - 1].endOffset);
      }
      expect(pages.length).toBeGreaterThan(1);
    } finally {
      Element.prototype.getBoundingClientRect = original;
      element.remove();
    }
  });
});

describe("leading paragraph spaces", () => {
  it("hides a paragraph's own leading spaces without changing its text", () => {
    const root = document.createElement("div");
    const text = "　　第一段\n  second\n　　\n续行";
    renderReaderText(root, text, { continued: false });
    expect(root.textContent).toBe(text);
    const paragraphs = root.querySelectorAll("p");
    expect(paragraphs[0].querySelector("span[hidden]")?.textContent).toBe("　　");
    expect(paragraphs[1].querySelector("span[hidden]")?.textContent).toBe("  ");
    // A line of only spaces keeps its line box.
    expect(paragraphs[2].querySelector("span[hidden]")).toBeNull();
    const continued = document.createElement("div");
    renderReaderText(continued, "　　接上页", { continued: true });
    expect(continued.querySelector("span[hidden]")).toBeNull();
  });
});

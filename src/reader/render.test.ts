// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { bookImages, setReaderImages, withoutMarks } from "./images";
import { windowParagraphs } from "./read-aloud";
import { continuesLine, renderReaderText, spreadFill, translatedLineAt } from "./render";

function render(text: string, continued = false, highlight?: { start: number; end: number }) {
  const container = document.createElement("div");
  renderReaderText(container, text, { continued, highlight });
  return container;
}

afterEach(() => setReaderImages(null));

describe("EPUB marks", () => {
  const mark = String.fromCodePoint(0xf0000);
  const text = `${mark}第一章\n\u3000\u3000正文\n\ue000\n${mark}尾`;

  it("hides directory marks with the indent and draws images in their place", () => {
    const read = vi.fn(async () => new ArrayBuffer(1));
    const images = bookImages([{ width: 400, height: 300 }], read);
    setReaderImages(images);
    const container = document.createElement("div");
    renderReaderText(container, text, { continued: false, headings: new Set([0]) });
    // Offsets hold: every mark is still in the text.
    expect(container.textContent).toBe(text);
    const [heading, body, picture] = Array.from(container.querySelectorAll("p"));
    expect(heading.dataset.heading).toBe("true");
    expect(heading.querySelector("span[hidden]")?.textContent).toBe(mark);
    expect(body.querySelector("span[hidden]")?.textContent).toBe("\u3000\u3000");
    expect(picture.dataset.image).toBe("true");
    const image = picture.querySelector("img")!;
    expect([image.width, image.height]).toEqual([400, 300]);
    expect(image.dataset.readerImage).toBe("0");
    expect(read).toHaveBeenCalledWith(0);
    images.dispose();
  });

  it("keeps an image line as hidden text when the book has no images", () => {
    const container = document.createElement("div");
    renderReaderText(container, "\ue000", { continued: false });
    expect(container.textContent).toBe("\ue000");
    expect(container.querySelector("img")).toBeNull();
  });

  it("is neither spoken nor shown in excerpts", () => {
    expect(windowParagraphs(text, 10, 10, 10).map((paragraph) => paragraph.text)).toEqual([
      "第一章",
      "正文",
      "尾",
    ]);
    expect(windowParagraphs(text, 0, 0, 1)[0].textStart).toBe(2);
    expect(withoutMarks(text)).toBe("第一章\n\u3000\u3000正文\n\n尾");
  });
});

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

describe("bottom alignment", () => {
  it("spreads the space over the gaps past their thresholds", () => {
    expect(spreadFill(12, [0, 0, 0])).toBe(4);
    // A heading gap absorbs 3px first: below that only the other two grow.
    expect(spreadFill(4, [3, 0, 0])).toBe(2);
    // Past it all three grow: 5 + 5 + (5 - 3) = 12.
    expect(spreadFill(12, [3, 0, 0])).toBe(5);
    // Past the threshold all three share: 2f - 0 + (f - 3) = 21 → f = 8.
    expect(spreadFill(21, [3, 0, 0])).toBe(8);
    expect(spreadFill(5, [2])).toBe(7);
  });
});

describe("translated lines", () => {
  const mark = String.fromCodePoint(0x100000);
  const text = `The night was quiet.\n${mark}夜很静。\n${mark}后来门开了。`;

  it("marks translated paragraphs and hides the mark", () => {
    const container = render(text);
    expect(container.textContent).toBe(text);
    const [original, first, second] = Array.from(container.querySelectorAll("p"));
    expect(original.dataset.translated).toBeUndefined();
    expect(first.dataset.translated).toBe("true");
    expect(second.dataset.translated).toBe("true");
    // The mark is hidden, not shown as a glyph.
    expect(first.querySelector("span[hidden]")?.textContent).toBe(mark);
    expect(withoutMarks(text)).not.toContain(mark);
  });

  it("knows a page continuing a translated line", () => {
    const middle = text.indexOf("门");
    expect(translatedLineAt(text, middle)).toBe(true);
    expect(translatedLineAt(text, 3)).toBe(false);
    // The line began before the window: its context says so.
    expect(translatedLineAt("门开了。", 0, `夜很静。\n${mark}后来`)).toBe(true);
    const container = document.createElement("div");
    renderReaderText(container, "门开了。", { continued: true, continuedTranslated: true });
    expect(container.querySelector("p")?.dataset.translated).toBe("true");
  });
});

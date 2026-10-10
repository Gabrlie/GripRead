// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderReaderText } from "../../reader";
import { readerSelection } from "./selection";

function page(text: string, start: number) {
  const root = document.createElement("div");
  root.dataset.testid = "reader-page";
  root.setAttribute("data-testid", "reader-page");
  root.dataset.start = String(start);
  renderReaderText(root, text, { continued: false });
  document.body.replaceChildren(root);
  return root;
}

function select(root: HTMLElement, text: string, from: number, to: number) {
  // Walk text nodes to the requested local offsets.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (from >= seen && from <= seen + length) range.setStart(node, from - seen);
    if (to >= seen && to <= seen + length) {
      range.setEnd(node, to - seen);
      break;
    }
    seen += length;
  }
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  expect(range.toString()).toBe(text.slice(from, to));
  return selection;
}

describe("selected text", () => {
  it("maps a selection across hidden indents and line feeds to book offsets", () => {
    const text = "　　第一段文字。\n　　第二段文字。";
    const root = page(text, 1000);
    const from = text.indexOf("文字");
    const to = text.lastIndexOf("第二段") + 3;
    const result = readerSelection(select(root, text, from, to));
    expect(result).toMatchObject({ start: 1000 + from, end: 1000 + to });
    expect(result?.text).toBe(text.slice(from, to));
  });

  it("ignores selections outside the page text and trims whitespace", () => {
    const text = "开头 中间 结尾";
    const root = page(text, 0);
    const result = readerSelection(select(root, text, 2, 6));
    expect(result).toMatchObject({ text: "中间", start: 3, end: 5 });
    const outside = document.createElement("p");
    outside.textContent = "菜单";
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(readerSelection(window.getSelection())).toBeNull();
  });
});

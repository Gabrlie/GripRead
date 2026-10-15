// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProgressPrompt, ReaderLocator, TocEntry } from "../../../types/generated";
import { setLanguage } from "../../../i18n";
import { CloudProgressDialog, chapterGap, chapterIndexOf } from "./CloudProgressDialog";

const at = (resourceId: string, offset: number): ReaderLocator => ({
  bookId: "b",
  contentVersion: "v",
  resourceId,
  offset,
  contextBefore: "",
  contextAfter: "",
});
const entry = (ordinal: number, title: string, locator: ReaderLocator): TocEntry => ({
  ordinal,
  title,
  volume: false,
  length: 100,
  locator,
});

describe("云端进度", () => {
  it("finds chapters by resource for online books and by offset for local ones", () => {
    const online = [0, 1, 2].map((index) => entry(index, `第${index + 1}章`, at(`c${index}`, 0)));
    expect(chapterIndexOf(online, at("c2", 40))).toBe(2);
    const local = [0, 1, 2].map((index) =>
      entry(index, `第${index + 1}章`, at("text", index * 100)),
    );
    expect(chapterIndexOf(local, at("text", 150))).toBe(1);
    expect(chapterGap(5, 2)).toBe("云端领先 3 章");
    expect(chapterGap(1, 4)).toBe("云端落后 3 章");
    expect(chapterGap(-1, 4)).toBeNull();
  });

  it("shows the cloud and local chapters with the gap", () => {
    const toc = Array.from({ length: 10 }, (_, index) =>
      entry(index, `章节${index + 1}`, at(`c${index}`, 0)),
    );
    const prompt: ProgressPrompt = {
      deviceId: "d",
      deviceName: "平板",
      revision: 1,
      writtenAt: Date.now(),
      chapterTitle: "章节8",
      excerpt: "他推开门",
      locator: at("c7", 10),
    };
    render(<CloudProgressDialog prompt={prompt} toc={toc} here={at("c2", 0)} onAnswer={vi.fn()} />);
    expect(screen.getByText("第 8 章 · 章节8")).toBeTruthy();
    expect(screen.getByText("第 3 章 · 章节3")).toBeTruthy();
    expect(screen.getByText(/云端领先 5 章/)).toBeTruthy();
  });

  it("reads in English", () => {
    setLanguage("en");
    try {
      const toc = [0, 1, 2, 3].map((index) =>
        entry(index, `Part ${index + 1}`, at(`c${index}`, 0)),
      );
      const prompt: ProgressPrompt = {
        deviceId: "d",
        deviceName: "",
        revision: 1,
        writtenAt: Date.now(),
        chapterTitle: "Part 4",
        excerpt: "",
        locator: at("c3", 0),
      };
      render(
        <CloudProgressDialog prompt={prompt} toc={toc} here={at("c0", 0)} onAnswer={vi.fn()} />,
      );
      expect(screen.getByText("Chapter 4 · Part 4")).toBeTruthy();
      expect(screen.getByText(/The cloud is 3 chapters ahead/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Jump" })).toBeTruthy();
    } finally {
      setLanguage("system");
    }
  });
});

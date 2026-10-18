// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ComicChapter, ReaderLocator } from "../types/generated";
import { tocEntry } from "../test/toc";
import { ComicPages, chapterOf, comicChapters, coreIndex, isComic, pageOf } from "./comic";

const at = (resourceId: string, offset: number): ReaderLocator => ({
  bookId: "b",
  contentVersion: "v",
  resourceId,
  offset,
  contextBefore: "",
  contextAfter: "",
});

describe("comic places", () => {
  it("maps online chapters by resource and local ones by offset", () => {
    const online = comicChapters([
      { ...tocEntry(0, "第一卷", at("chapter-0", 0)), volume: true },
      tocEntry(1, "第1话", at("chapter-1", 0)),
      tocEntry(2, "第2话", at("chapter-2", 0)),
    ]);
    expect(online.map((entry) => entry.title)).toEqual(["第1话", "第2话"]);
    expect(coreIndex(online, 1)).toBe(2);
    expect(chapterOf(online, at("chapter-2", 5))).toBe(1);
    const local = [tocEntry(0, "a", at("asset", 0)), tocEntry(1, "b", at("asset", 50))];
    expect(coreIndex(local, 1)).toBe(1);
    expect(chapterOf(local, at("asset", 60))).toBe(1);
    const chapter: ComicChapter = {
      index: 1,
      title: "b",
      resourceId: "asset",
      contentVersion: "v",
      pages: [52, 54, 56].map((offset) => ({ width: 0, height: 0, offset })),
    };
    expect(pageOf(chapter, at("asset", 55))).toBe(1);
    expect(isComic({ asset: { kind: "comic" }, online: null } as never)).toBe(true);
  });

  it("keeps recent pages and releases the rest", async () => {
    let next = 0;
    URL.createObjectURL = vi.fn(() => `blob:${(next += 1)}`);
    URL.revokeObjectURL = vi.fn();
    const service = {
      getComicChapter: vi.fn(),
      readComicPage: vi.fn(async () => new ArrayBuffer(1)),
    };
    const pages = new ComicPages(service, "b");
    const first = await pages.page(0, 0);
    expect(await pages.page(0, 0)).toBe(first);
    expect(service.readComicPage).toHaveBeenCalledTimes(1);
    for (let page = 1; page <= 40; page += 1) await pages.page(0, page);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
    pages.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(41);
  });
});

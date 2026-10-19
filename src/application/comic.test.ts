// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ComicChapter, ReaderLocator } from "../types/generated";
import { tocEntry } from "../test/toc";
import {
  ComicPages,
  PAGE_DOWNLOADS,
  PageCancelled,
  chapterOf,
  comicChapters,
  coreIndex,
  isComic,
  pageOf,
} from "./comic";

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

  it("downloads a few pages at a time, nearest the place read first", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const started: string[] = [];
    const finish: Array<() => void> = [];
    const service = {
      getComicChapter: vi.fn(),
      readComicPage: vi.fn(
        (_book: string, chapter: number, page: number) =>
          new Promise<ArrayBuffer>((resolve) => {
            started.push(`${chapter}:${page}`);
            finish.push(() => resolve(new ArrayBuffer(1)));
          }),
      ),
    };
    const pages = new ComicPages(service, "b");
    pages.focus(0, 5);
    // Preloading asks for pages ahead before the page on screen asks.
    const ahead = [6, 7, 8, 9, 10, 30].map((page) => pages.page(0, page).catch((e) => e));
    const shown = pages.page(0, 5);
    expect(started).toEqual(["0:6", "0:7", "0:8"]);
    expect(started.length).toBe(PAGE_DOWNLOADS);
    finish.shift()!();
    await vi.waitFor(() => expect(started).toContain("0:5"));
    expect(started[3]).toBe("0:5");
    // Moving far away drops what waits there; what waits near goes on.
    pages.focus(0, 40);
    expect(await ahead[3]).toBeInstanceOf(PageCancelled);
    expect(await ahead[4]).toBeInstanceOf(PageCancelled);
    for (const done of finish.splice(0)) done();
    await shown;
    await vi.waitFor(() => expect(started).toContain("0:30"));
    pages.dispose();
  });

  it("keeps the images on screen while releasing older ones", async () => {
    let next = 0;
    URL.createObjectURL = vi.fn(() => `blob:${(next += 1)}`);
    URL.revokeObjectURL = vi.fn();
    const service = {
      getComicChapter: vi.fn(),
      readComicPage: vi.fn(async () => new ArrayBuffer(1)),
    };
    const pages = new ComicPages(service, "b");
    const shown = await pages.page(0, 0);
    pages.hold(0, 0);
    for (let page = 1; page <= 45; page += 1) await pages.page(0, page);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(shown);
    pages.release(0, 0);
    await pages.page(0, 46);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(shown);
    pages.dispose();
  });
});

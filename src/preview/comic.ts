import type {
  ComicChapter,
  LibraryBook,
  ReaderLocator,
  TocEntry,
  TocListing,
} from "../types/generated";

/** A comic for previewing the comic reader: drawn pages, no real content. */
export const PREVIEW_COMIC_ID = "preview-comic";
const VERSION = "preview-comic-v1";
const RESOURCE = "preview-comic-asset";
const CHAPTERS = 3;
const PAGES = 8;

/** Page heights in a chapter: tall strip panels, then ordinary pages. */
const height = (page: number) => [1600, 1100, 900, 1300][page % 4];

const locator = (offset: number): ReaderLocator => ({
  bookId: PREVIEW_COMIC_ID,
  contentVersion: VERSION,
  resourceId: RESOURCE,
  offset,
  contextBefore: "",
  contextAfter: "",
});

const offset = (chapter: number, page: number) => chapter * 100 + page;

export const previewComicBook = (): LibraryBook => ({
  book: {
    id: PREVIEW_COMIC_ID,
    title: "预览漫画",
    author: "预览作者",
    contentVersion: VERSION,
    createdAt: 1,
    updatedAt: 1,
  },
  asset: {
    id: RESOURCE,
    bookId: PREVIEW_COMIC_ID,
    kind: "comic",
    sha256: "preview-comic",
    byteLength: 1,
    contentVersion: VERSION,
    availability: "ready",
    createdAt: 1,
  },
  locator: null,
  totalLength: offset(CHAPTERS, 0),
  txtEncoding: null,
  lastReadAt: Date.now() - 60_000,
  removedAt: null,
  shelfState: null,
  coverAssetId: null,
  useReplaceRules: true,
  inCloud: false,
  online: null,
});

export function previewComicToc(): TocListing {
  const entries: TocEntry[] = Array.from({ length: CHAPTERS }, (_, chapter) => ({
    ordinal: chapter,
    title: `第${chapter + 1}话 预览`,
    volume: false,
    length: PAGES,
    locator: locator(offset(chapter, 0)),
  }));
  return {
    entries,
    ruleId: null,
    ruleName: "",
    settings: { ruleId: null, splitLongChapters: false, asked: false, innerChapters: false },
    fixed: true,
  };
}

export function previewComicChapter(index: number): ComicChapter {
  return {
    index,
    title: `第${index + 1}话 预览`,
    resourceId: RESOURCE,
    contentVersion: VERSION,
    // Sizes are left unknown, as for an online chapter not yet kept.
    pages: Array.from({ length: PAGES }, (_, page) => ({
      width: 0,
      height: 0,
      offset: offset(index, page),
    })),
  };
}

/** A drawn page: its number on a coloured panel, after a short wait like a download. */
export async function previewComicPage(chapter: number, page: number): Promise<ArrayBuffer> {
  await new Promise((resolve) => setTimeout(resolve, 150 + ((chapter * PAGES + page) % 5) * 80));
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = height(page);
  const context = canvas.getContext("2d")!;
  context.fillStyle = `hsl(${(chapter * 70 + page * 23) % 360} 45% 78%)`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#333";
  context.lineWidth = 6;
  context.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
  context.fillStyle = "#222";
  context.font = "bold 72px sans-serif";
  context.textAlign = "center";
  context.fillText(`${chapter + 1}-${page + 1}`, canvas.width / 2, canvas.height / 2);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made!)));
  return blob.arrayBuffer();
}

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import { previewServices } from "../../preview/services";
import type {
  ComicChapter,
  LibraryBook,
  ReaderLocator,
  ReaderPreferences,
} from "../../types/generated";
import { tocEntry, tocListing } from "../../test/toc";
import { ComicReader } from "./ComicReader";

const navigation = vi.hoisted(() => ({
  activeBook: null as LibraryBook | null,
  closeReader: vi.fn(),
  takeReaderPage: vi.fn((): "contents" | null => null),
}));
vi.mock("../../context/AppContext", () => ({ useApp: () => navigation }));

const at = (offset: number): ReaderLocator => ({
  bookId: "comic",
  contentVersion: "v",
  resourceId: "asset",
  offset,
  contextBefore: "",
  contextAfter: "",
});

/** A local comic: two chapters of three pages, page offsets 10 apart. */
function chapter(index: number): ComicChapter {
  return {
    index,
    title: `第${index + 1}话`,
    resourceId: "asset",
    contentVersion: "v",
    pages: [0, 1, 2].map((page) => ({ width: 3, height: 4, offset: index * 100 + 10 + page * 10 })),
  };
}

function setup(preferences: Partial<ReaderPreferences> = {}, saved: ReaderLocator | null = null) {
  const services = previewServices();
  const base = services.settings.getSettings;
  services.settings.getSettings = async () => ({ ...(await base()), ...preferences });
  services.reader.listToc = vi.fn(async () =>
    tocListing([tocEntry(0, "第1话", at(0)), tocEntry(1, "第2话", at(100))]),
  );
  services.reader.getSavedReaderLocator = vi.fn(async () => saved);
  services.reader.saveReaderLocator = vi.fn(async (locator: ReaderLocator) => locator);
  services.reader.listBookmarks = vi.fn(async () => []);
  services.library.getComicChapter = vi.fn(async (_book: string, index: number) => chapter(index));
  services.library.readComicPage = vi.fn(async () => new ArrayBuffer(4));
  const app = new AppRuntime(services);
  navigation.activeBook = {
    book: { id: "comic", title: "海贼", author: null },
    asset: { kind: "comic" },
    online: null,
  } as unknown as LibraryBook;
  return app;
}

async function view(app: AppRuntime) {
  await app.settings.load();
  render(
    <RuntimeContext.Provider value={app}>
      <ComicReader />
    </RuntimeContext.Provider>,
  );
  await screen.findByTestId("comic-reader");
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:page-${(next += 1)}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComicReader", () => {
  it("opens at the saved page and turns pages across chapters, saving the place", async () => {
    const app = setup(
      {
        comic: {
          mode: "paged",
          direction: "left_to_right",
          fit: "screen",
          gap: 0,
          preload: 2,
          background: "black",
          pageNumber: true,
        },
      },
      at(120),
    );
    await view(app);
    // 120 is chapter 2's second page.
    expect(await screen.findByText("2/3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText("3/3")).toBeTruthy();
    await waitFor(() =>
      expect(app.services.reader.saveReaderLocator).toHaveBeenLastCalledWith(at(130)),
    );
    // Back past the start of chapter 2 is chapter 1's last page.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(app.services.reader.saveReaderLocator).toHaveBeenLastCalledWith(at(30)),
    );
    expect(app.services.library.getComicChapter).toHaveBeenCalledWith("comic", 0);
  });

  it("turns the other way for right-to-left manga", async () => {
    const app = setup({
      comic: {
        mode: "paged",
        direction: "right_to_left",
        fit: "screen",
        gap: 0,
        preload: 2,
        background: "theme",
        pageNumber: true,
      },
    });
    await view(app);
    expect(await screen.findByText("1/3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(await screen.findByText("2/3")).toBeTruthy();
  });

  it("offers a retry for a page that failed, and for a chapter that could not open", async () => {
    const app = setup({
      comic: {
        mode: "paged",
        direction: "left_to_right",
        fit: "screen",
        gap: 0,
        preload: 1,
        background: "theme",
        pageNumber: false,
      },
    });
    vi.mocked(app.services.library.readComicPage).mockRejectedValueOnce(new Error("timeout"));
    await view(app);
    const retry = await screen.findByRole("button", { name: /加载失败，点击重试/ });
    await userEvent.click(retry);
    expect(await screen.findByRole("img", { name: "第 1 页" })).toBeTruthy();

    cleanup();
    const broken = setup();
    vi.mocked(broken.services.library.getComicChapter).mockRejectedValue(new Error("offline"));
    await broken.settings.load();
    render(
      <RuntimeContext.Provider value={broken}>
        <ComicReader />
      </RuntimeContext.Provider>,
    );
    expect(await screen.findByText(/漫画打开失败/)).toBeTruthy();
    vi.mocked(broken.services.library.getComicChapter).mockImplementation(async (_book, index) =>
      chapter(index),
    );
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("comic-reader")).toBeTruthy();
  });

  it("shows the strip with only pages near the screen loaded, and saves settings", async () => {
    const app = setup({
      comic: {
        mode: "scroll",
        direction: "left_to_right",
        fit: "width",
        gap: 0,
        preload: 1,
        background: "theme",
        pageNumber: true,
      },
    });
    await view(app);
    const strip = await screen.findByRole("region", { name: "第1话" });
    await waitFor(() => expect(within(strip).getAllByRole("img").length).toBeGreaterThan(0));
    // Tapping the middle shows the menu, after waiting out a double tap.
    const surface = screen.getByTestId("comic-reader").firstElementChild as HTMLElement;
    surface.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 300,
        height: 600,
        right: 300,
        bottom: 600,
        x: 0,
        y: 0,
      }) as DOMRect;
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 150, clientY: 300 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 150, clientY: 300 });
    await userEvent.click(await screen.findByRole("button", { name: /漫画设置/ }));
    await userEvent.click(await screen.findByRole("radio", { name: "单页" }));
    await waitFor(() => expect(app.settings.getSnapshot().value?.comic?.mode).toBe("paged"));
  });
});

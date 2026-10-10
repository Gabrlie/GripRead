// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageTurnAdapter } from "./page-turn";
import type { ReaderDisplayedPage, ReaderPresentationContext } from "./types";

function page(text: string, startOffset: number): ReaderDisplayedPage {
  return {
    text,
    startOffset,
    endOffset: startOffset + text.length,
    hasBefore: startOffset > 0,
    hasAfter: true,
    totalLength: 100,
    locator: {
      bookId: "book",
      contentVersion: "v",
      resourceId: "r",
      offset: startOffset,
      contextBefore: "",
      contextAfter: "",
    },
    continued: false,
  };
}

const context = (pages: ReaderDisplayedPage[], index: number): ReaderPresentationContext => ({
  pages,
  index,
  reducedMotion: false,
  visiblePages: [pages[index]],
});

function setup(effect: "curl" | "instant" = "curl") {
  const host = document.createElement("div");
  host.getBoundingClientRect = () => new DOMRect(0, 0, 400, 700);
  document.body.append(host);
  const frames: Array<(time: number) => void> = [];
  let time = 0;
  const adapter = new PageTurnAdapter(host, {
    effect,
    curlDuration: 100,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: () => undefined,
    now: () => time,
  });
  const tick = (ms: number) => {
    time += ms;
    frames.splice(0).forEach((frame) => frame(time));
  };
  const first = page("first page", 0);
  const second = page("second page", 10);
  return { host, adapter, tick, first, second, pages: [first, second] };
}

const drawn = vi.fn();
beforeEach(() => {
  // jsdom has neither canvas rendering nor Path2D; record that frames draw.
  vi.stubGlobal(
    "Path2D",
    class {
      rect() {}
      moveTo() {}
      lineTo() {}
      quadraticCurveTo() {}
      closePath() {}
      addPath() {}
    },
  );
  const context = new Proxy(
    {},
    {
      get: (_, key) =>
        key === "createLinearGradient"
          ? () => ({ addColorStop() {} })
          : key === "measureText"
            ? () => ({ fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 })
            : key === "drawImage"
              ? drawn
              : () => undefined,
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  drawn.mockClear();
  document.body.replaceChildren();
});

describe("PageTurnAdapter", () => {
  it("holds the outgoing page until the curl draws, then ends on its last frame", async () => {
    const { host, adapter, tick, first, second, pages } = setup();
    adapter.setPages(pages, 0);
    await adapter.present(first, "open", context(pages, 0));
    adapter.hold();
    adapter.setPages(pages, 1);
    expect(host.textContent).toContain("first page");
    const turning = adapter.present(second, "next", context(pages, 1));
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(drawn).toHaveBeenCalled();
    expect(host.textContent).not.toContain("first page");
    tick(50);
    tick(60);
    await turning;
    expect(host.querySelector("canvas")).toBeNull();
    expect(host.firstElementChild?.getAttribute("style")).toContain("visibility: hidden");
    adapter.dispose();
  });

  it("settles a curl interrupted by the toolbar or a new turn and keeps turning", async () => {
    const { host, adapter, tick, first, second, pages } = setup();
    adapter.setPages(pages, 0);
    await adapter.present(first, "open", context(pages, 0));
    adapter.setPages(pages, 1);
    const turning = adapter.present(second, "next", context(pages, 1));
    adapter.cancel();
    await turning;
    expect(host.querySelector("canvas")).toBeNull();
    adapter.setPages(pages, 0);
    const back = adapter.present(first, "previous", context(pages, 0));
    expect(host.querySelector("canvas")).not.toBeNull();
    tick(200);
    await back;
    expect(host.querySelector("canvas")).toBeNull();
    adapter.dispose();
  });

  it("presents instantly without overlays for the instant effect and seeks", async () => {
    const { host, adapter, first, second, pages } = setup("instant");
    adapter.setPages(pages, 0);
    await adapter.present(first, "open", context(pages, 0));
    adapter.hold();
    adapter.setPages(pages, 1);
    await adapter.present(second, "next", context(pages, 1));
    expect(host.querySelector("canvas")).toBeNull();
    expect(host.textContent).toBe("");
    adapter.dispose();
  });
});

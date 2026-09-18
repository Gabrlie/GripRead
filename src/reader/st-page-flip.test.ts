// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { StPageFlipAdapter, type StPageFlipLike } from "./st-page-flip";
import type { ReaderDisplayedPage, ReaderPresentationContext } from "./types";

type Handler = (...args: unknown[]) => void;

function page(bookId: string, text: string, startOffset: number, totalLength: number) {
  const endOffset = startOffset + text.length;
  return {
    text,
    startOffset,
    endOffset,
    hasBefore: startOffset > 0,
    hasAfter: endOffset < totalLength,
    totalLength,
    locator: {
      bookId,
      contentVersion: "version",
      resourceId: "resource",
      offset: startOffset,
      contextBefore: "",
      contextAfter: "",
    },
  } satisfies ReaderDisplayedPage;
}

function context(
  pages: readonly ReaderDisplayedPage[],
  index: number,
  reducedMotion = false,
): ReaderPresentationContext {
  return { pages, index, reducedMotion };
}

function mockPageFlip() {
  const handlers = new Map<string, Set<Handler>>();
  const loadFromHTML = vi.fn();
  const updateFromHtml = vi.fn();
  const turnToPage = vi.fn();
  const flipNext = vi.fn();
  const flipPrev = vi.fn();
  const destroy = vi.fn();
  const settings = { flippingTime: 40 };
  const mock: StPageFlipLike = {
    loadFromHTML,
    updateFromHtml,
    turnToPage,
    flipNext,
    flipPrev,
    destroy,
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? new Set<Handler>();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
    },
    off(event, handler) {
      if (!handler) {
        handlers.delete(event);
        return;
      }
      handlers.get(event)?.delete(handler);
    },
    getSettings: () => settings,
  };
  return {
    mock,
    loadFromHTML,
    updateFromHtml,
    turnToPage,
    flipNext,
    flipPrev,
    destroy,
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

function hostForTest(): { host: HTMLElement; mount: HTMLElement } {
  const host = document.createElement("div");
  host.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
  document.body.append(host);
  const mount = host.ownerDocument.createElement("div");
  host.append(mount);
  return { host, mount };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("StPageFlipAdapter", () => {
  it("clears the fallback timer when PageFlip reports an early flip", async () => {
    vi.useFakeTimers();
    const { host, mount } = hostForTest();
    const flip = mockPageFlip();
    const adapter = new StPageFlipAdapter(host, {
      pageFlip: flip.mock,
      mount,
      width: 100,
      height: 100,
      flippingTime: 40,
    });
    const first = page("book", "a", 0, 2);
    const second = page("book", "b", 1, 2);
    adapter.setPages([first], 0);
    await adapter.present(first, "open", context([first], 0));
    adapter.setPages([first, second], 0);

    const turning = adapter.present(second, "next", context([first, second], 1));
    expect(mount.style.visibility).toBe("visible");
    flip.emit("flip");
    await turning;
    expect(mount.style.visibility).toBe("hidden");
    expect(vi.getTimerCount()).toBe(0);
    expect(flip.destroy).not.toHaveBeenCalled();

    adapter.setPages([first, second], 0);
    const nextTurning = adapter.present(second, "next", context([first, second], 1));
    expect(flip.updateFromHtml).toHaveBeenCalledTimes(1);
    flip.emit("flip");
    await nextTurning;
    adapter.dispose();
  });

  it("resets PageFlip when a turn is cancelled by new pages or resize", async () => {
    const { host, mount } = hostForTest();
    const flips: ReturnType<typeof mockPageFlip>[] = [];
    const adapter = new StPageFlipAdapter(host, {
      mount,
      width: 100,
      height: 100,
      flippingTime: 1000,
      createPageFlip: () => {
        const flip = mockPageFlip();
        flips.push(flip);
        return flip.mock;
      },
    });
    const first = page("book", "a", 0, 3);
    const second = page("book", "b", 1, 3);
    const third = page("book", "c", 2, 3);
    adapter.setPages([first], 0);
    await adapter.present(first, "open", context([first], 0));
    adapter.setPages([first, second], 0);

    const cancelledByPages = adapter.present(second, "next", context([first, second], 1));
    const firstFlip = flips[0];
    expect(firstFlip).toBeDefined();
    adapter.setPages([second, third], 0);
    await cancelledByPages;
    expect(firstFlip?.destroy).toHaveBeenCalledTimes(1);
    expect(adapter.currentPageFlip).toBeNull();
    expect(mount.style.visibility).toBe("hidden");

    const replacement = adapter.present(third, "next", context([second, third], 1));
    const secondFlip = flips[1];
    expect(secondFlip).toBeDefined();
    adapter.resize();
    await replacement;
    expect(secondFlip?.destroy).toHaveBeenCalledTimes(1);
    expect(adapter.currentPageFlip).toBeNull();
    adapter.dispose();
  });

  it("cancels active animation for reduced motion and presents later turns instantly", async () => {
    const { host, mount } = hostForTest();
    const flip = mockPageFlip();
    const adapter = new StPageFlipAdapter(host, {
      pageFlip: flip.mock,
      mount,
      width: 100,
      height: 100,
      flippingTime: 1000,
    });
    const first = page("book", "a", 0, 3);
    const second = page("book", "b", 1, 3);
    const third = page("book", "c", 2, 3);
    adapter.setPages([first], 0);
    await adapter.present(first, "open", context([first], 0));
    adapter.setPages([first, second], 0);

    const turning = adapter.present(second, "next", context([first, second], 1));
    adapter.setReducedMotion(true);
    await turning;
    expect(flip.destroy).toHaveBeenCalledTimes(1);
    expect(mount.style.visibility).toBe("hidden");

    adapter.setPages([second, third], 0);
    await adapter.present(third, "next", context([second, third], 1));
    expect(flip.flipNext).toHaveBeenCalledTimes(1);
    expect(mount.style.visibility).toBe("hidden");
    adapter.dispose();
  });

  it("disposes the injected PageFlip and resolves a pending presentation", async () => {
    const { host, mount } = hostForTest();
    const flip = mockPageFlip();
    const adapter = new StPageFlipAdapter(host, {
      pageFlip: flip.mock,
      mount,
      width: 100,
      height: 100,
      flippingTime: 1000,
    });
    const first = page("book", "a", 0, 2);
    const second = page("book", "b", 1, 2);
    adapter.setPages([first], 0);
    await adapter.present(first, "open", context([first], 0));
    adapter.setPages([first, second], 0);

    const turning = adapter.present(second, "next", context([first, second], 1));
    adapter.dispose();
    await turning;

    expect(flip.destroy).toHaveBeenCalledTimes(1);
    expect(adapter.currentPageFlip).toBeNull();
    expect(host.contains(mount)).toBe(true);
    expect(mount.childElementCount).toBe(0);
    await adapter.present(second, "next", context([first, second], 1));
    expect(flip.flipNext).toHaveBeenCalledTimes(1);
  });
});

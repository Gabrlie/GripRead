import { describe, expect, it, vi } from "vitest";
import type { SpeechEngine, SpeechEvent, SpeechItem } from "../services/speech";
import { ReadAloud, windowParagraphs } from "./read-aloud";

function fakeEngine() {
  let listener: ((event: SpeechEvent) => void) | null = null;
  const spoken: SpeechItem[][] = [];
  const engine: SpeechEngine = {
    available: () => true,
    speak: vi.fn((items: SpeechItem[], _options, flush: boolean) => {
      if (flush) spoken.length = 0;
      spoken.push(items);
    }),
    stop: vi.fn(),
    voices: async () => [],
    onEvent: (next) => {
      listener = next;
      return () => (listener = null);
    },
  };
  const queue = () => spoken.flat();
  const emit = (type: SpeechEvent["type"], index: number) =>
    listener?.({ type, id: queue()[index].id });
  return { engine, queue, emit };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("read-aloud", () => {
  const text = Array.from({ length: 30 }, (_, index) => `第${index}段。`).join("\n");

  it("splits the loaded text into spoken paragraphs from an offset", () => {
    const paragraphs = windowParagraphs("一\n\n  二 \n三", 100, 102, 5);
    expect(paragraphs).toEqual([
      { start: 103, end: 107, text: "二" },
      { start: 108, end: 109, text: "三" },
    ]);
  });

  it("reads from the page, follows onto later pages, refills, and stops", async () => {
    const { engine, queue, emit } = fakeEngine();
    let page = { start: 0, end: 20 };
    const highlight = vi.fn();
    const next = vi.fn(async () => {
      page = { start: page.end, end: page.end + 20 };
      return true;
    });
    const reader = new ReadAloud(
      engine,
      {
        paragraphs: (offset, limit) => windowParagraphs(text, 0, offset, limit),
        pageStart: () => page.start,
        pageEnd: () => page.end,
        next,
        highlight,
      },
      { rate: 1, pitch: 1, voice: null },
    );
    reader.start();
    await flush();
    expect(queue()).toHaveLength(12);
    expect(queue()[0].text).toBe("第0段。");
    emit("start", 0);
    expect(highlight).toHaveBeenLastCalledWith({ start: 0, end: 4 });
    // The fifth paragraph starts beyond the first page: the page turns.
    emit("start", 5);
    await flush();
    expect(next).toHaveBeenCalled();
    // Near the end of the batch the next one is queued without a gap.
    emit("start", 10);
    await flush();
    expect(queue()).toHaveLength(24);
    expect(queue()[12].text).toBe("第12段。");
    reader.pause();
    expect(reader.getSnapshot().state).toBe("paused");
    reader.resume();
    await flush();
    expect(queue()[0].text).toBe("第10段。");
    reader.sleepAfter(30, 0);
    expect(reader.getSnapshot().stopsAt).toBe(30 * 60_000);
    reader.stop();
    expect(highlight).toHaveBeenLastCalledWith(null);
    expect(reader.getSnapshot()).toEqual({ state: "idle", current: null, stopsAt: null });
    reader.dispose();
  });

  it("stops at the end of the book", async () => {
    const { engine, queue, emit } = fakeEngine();
    const reader = new ReadAloud(
      engine,
      {
        paragraphs: (offset, limit) => windowParagraphs("最后一段", 0, offset, limit),
        pageStart: () => 0,
        pageEnd: () => 4,
        next: async () => false,
        highlight: () => undefined,
      },
      { rate: 1, pitch: 1, voice: null },
    );
    reader.start();
    await flush();
    emit("start", 0);
    emit("done", queue().length - 1);
    await flush();
    expect(reader.getSnapshot().state).toBe("idle");
  });
});

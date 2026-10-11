import type { SpeechEngine, SpeechItem, SpeechOptions } from "../services/speech";

/** One spoken paragraph with its absolute UTF-16 range. */
export interface ReadAloudParagraph {
  start: number;
  end: number;
  /** The spoken text: the line without surrounding blanks. */
  text: string;
  /** Absolute offset where `text` begins, after the line's indent. */
  textStart: number;
}

export interface ReadAloudRange {
  start: number;
  end: number;
}

/** What read-aloud needs from the open book. */
export interface ReadAloudSource {
  /** Non-blank paragraphs of the loaded text from `offset`, at most `limit`. */
  paragraphs(offset: number, limit: number): ReadAloudParagraph[];
  /** The start and exclusive end of the visible page/spread. */
  pageStart(): number;
  pageEnd(): number;
  /**
   * Turns one page/spread forward, or loads more text while scrolling;
   * `false` at the end of the book.
   */
  next(): Promise<boolean>;
  /**
   * Marks the paragraph being read and, when the engine reports progress
   * within it, the words being spoken; `null` clears both.
   */
  highlight(paragraph: ReadAloudRange | null, spoken: ReadAloudRange | null): void;
}

export type ReadAloudState = "idle" | "playing" | "paused";

export interface ReadAloudSnapshot {
  state: ReadAloudState;
  current: ReadAloudParagraph | null;
  /** When the sleep timer stops reading, as epoch milliseconds. */
  stopsAt: number | null;
  /** The engine reported an error for something it was asked to speak. */
  failed: boolean;
}

const BATCH = 12;

/**
 * Legado's 朗读: speaks paragraph by paragraph from the visible page,
 * highlights the paragraph being read and, where the engine reports it, the
 * words being spoken, turns pages as the spoken words pass the page end, and
 * continues into later text. A batch is queued ahead, so the engine
 * keeps speaking while the page is in the background; the next batch is
 * queued before the current one runs out.
 */
export class ReadAloud {
  private snapshot: ReadAloudSnapshot = {
    state: "idle",
    current: null,
    stopsAt: null,
    failed: false,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private queued: { id: string; paragraph: ReadAloudParagraph }[] = [];
  private refilled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: () => void;
  private turning: Promise<void> = Promise.resolve();

  public constructor(
    private readonly engine: SpeechEngine,
    private readonly source: ReadAloudSource,
    private options: SpeechOptions,
  ) {
    this.unsubscribe = engine.onEvent((event) => {
      if (event.type === "start") this.started(event.id);
      else if (event.type === "range") this.spoke(event.id, event.start, event.end);
      else {
        if (event.type === "error" && this.live(event.id) >= 0 && !this.snapshot.failed)
          this.update({ failed: true });
        this.finished(event.id);
      }
    });
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<ReadAloudSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  public available(): boolean {
    return this.engine.available();
  }

  public setOptions(options: SpeechOptions): void {
    const changed =
      options.rate !== this.options.rate ||
      options.pitch !== this.options.pitch ||
      options.voice !== this.options.voice;
    this.options = options;
    // Queued speech keeps its settings; restart the current paragraph.
    if (changed && this.snapshot.state === "playing" && this.snapshot.current)
      void this.queueFrom(this.snapshot.current.start, true);
  }

  public start(): void {
    this.update({ state: "playing", failed: false });
    void this.queueFrom(this.source.pageStart(), true);
  }

  public pause(): void {
    if (this.snapshot.state !== "playing") return;
    this.generation += 1;
    this.engine.stop();
    this.update({ state: "paused" });
  }

  public resume(): void {
    if (this.snapshot.state !== "paused") return;
    this.update({ state: "playing" });
    void this.queueFrom(this.snapshot.current?.start ?? this.source.pageStart(), true);
  }

  public stop(): void {
    this.generation += 1;
    this.engine.stop();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queued = [];
    this.source.highlight(null, null);
    this.update({ state: "idle", current: null, stopsAt: null });
  }

  /** Moves to the previous (`-1`) or next (`1`) paragraph. */
  public skip(step: -1 | 1): void {
    const current = this.snapshot.current;
    if (!current || this.snapshot.state === "idle") return;
    if (step === 1) {
      void this.queueFrom(current.end, true);
      return;
    }
    // Paragraphs before the current one, from the visible page onward.
    const before = this.source
      .paragraphs(Math.min(this.source.pageStart(), current.start), 200)
      .filter((paragraph) => paragraph.end <= current.start);
    void this.queueFrom(before.at(-1)?.start ?? current.start, true);
  }

  /** Stops reading after `minutes`; `null` cancels the timer. */
  public sleepAfter(minutes: number | null, now = Date.now()): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (minutes === null) {
      this.update({ stopsAt: null });
      return;
    }
    this.timer = setTimeout(() => this.stop(), minutes * 60_000);
    this.update({ stopsAt: now + minutes * 60_000 });
  }

  public dispose(): void {
    this.stop();
    this.unsubscribe();
    this.listeners.clear();
  }

  private async queueFrom(offset: number, flush: boolean): Promise<void> {
    const generation = flush ? ++this.generation : this.generation;
    let paragraphs = this.source.paragraphs(offset, BATCH);
    if (!paragraphs.length && flush) {
      // The loaded text ends here; later text arrives once the page turns
      // or scrolling loads it.
      if (!(await this.source.next()) || generation !== this.generation) {
        if (generation === this.generation) this.stop();
        return;
      }
      paragraphs = this.source.paragraphs(offset, BATCH);
      if (!paragraphs.length) paragraphs = this.source.paragraphs(this.source.pageStart(), BATCH);
    }
    if (generation !== this.generation || this.snapshot.state !== "playing") return;
    if (!paragraphs.length) {
      if (flush) this.stop();
      return;
    }
    const items = paragraphs.map((paragraph, index) => ({
      id: `${generation}:${paragraph.start}:${index}`,
      paragraph,
    }));
    this.queued = flush ? items : [...this.queued, ...items];
    this.refilled = false;
    if (flush) this.update({ current: paragraphs[0] });
    this.engine.speak(
      items.map(({ id, paragraph }): SpeechItem => ({ id, text: paragraph.text })),
      this.options,
      flush,
    );
  }

  private live(id: string): number {
    return id.startsWith(`${this.generation}:`)
      ? this.queued.findIndex((item) => item.id === id)
      : -1;
  }

  private started(id: string): void {
    const index = this.live(id);
    if (index < 0) return;
    const paragraph = this.queued[index].paragraph;
    this.update({ current: paragraph });
    this.source.highlight({ start: paragraph.start, end: paragraph.end }, null);
    this.follow(paragraph.textStart);
    if (!this.refilled && index >= this.queued.length - 2) {
      this.refilled = true;
      void this.queueFrom(this.queued.at(-1)!.paragraph.end, false);
    }
  }

  /** The engine reached `start`–`end` of an utterance's text. */
  private spoke(id: string, start: number, end: number): void {
    const index = this.live(id);
    if (index < 0 || start < 0) return;
    const paragraph = this.queued[index].paragraph;
    const spoken = {
      start: Math.min(paragraph.end, paragraph.textStart + start),
      end: Math.min(paragraph.end, paragraph.textStart + Math.max(start + 1, end)),
    };
    this.source.highlight({ start: paragraph.start, end: paragraph.end }, spoken);
    this.follow(spoken.start);
  }

  /** Turns pages until `offset` is on screen. */
  private follow(offset: number): void {
    this.turning = this.turning.then(async () => {
      for (let turns = 0; turns < 4 && offset >= this.source.pageEnd(); turns += 1) {
        if (!(await this.source.next())) break;
      }
    });
  }

  private finished(id: string): void {
    const index = this.live(id);
    if (index < 0 || index !== this.queued.length - 1) return;
    // The batch ran out before more text was available.
    void this.queueFrom(this.queued[index].paragraph.end, true);
  }
}

/** Paragraphs of a loaded text window, for `ReadAloudSource.paragraphs`. */
export function windowParagraphs(
  text: string,
  windowStart: number,
  offset: number,
  limit: number,
): ReadAloudParagraph[] {
  const result: ReadAloudParagraph[] = [];
  let index = Math.max(0, offset - windowStart);
  while (index < text.length && result.length < limit) {
    const newline = text.indexOf("\n", index);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(index, end);
    const spoken = line.trim();
    if (spoken)
      result.push({
        start: windowStart + index,
        end: windowStart + end,
        text: spoken,
        textStart: windowStart + index + (line.length - line.trimStart().length),
      });
    index = end + 1;
  }
  return result;
}

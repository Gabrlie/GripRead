import type { SyncService } from "../services/contracts";
import type { ProgressPrompt } from "../types/generated";

/** The same cloud version of a book. */
function promptKey(prompt: ProgressPrompt): string {
  return `${prompt.deviceId}:${prompt.revision}`;
}

/**
 * Orders a book's progress uploads and fetches (Legado 同步阅读进度). A fetch
 * waits for the book's pending upload, so a slow server never answers with
 * the position this device is still sending; the server side also ignores
 * this device's own records.
 *
 * An answered version is remembered at once: fetches already queued behind
 * the answer would otherwise bring the same question back before the core
 * has saved it. Fetches asked for while one waits to start share it.
 */
export class ProgressSync {
  private pending = new Map<string, Promise<unknown>>();
  private queued = new Map<string, Promise<ProgressPrompt | null>>();
  private answered = new Map<string, Set<string>>();

  constructor(private readonly service: SyncService) {}

  private after<T>(bookId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(bookId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.catch(() => undefined);
    this.pending.set(bookId, settled);
    void settled.then(() => {
      if (this.pending.get(bookId) === settled) this.pending.delete(bookId);
    });
    return next;
  }

  /** Uploads the saved position; failures are kept by the service for settings. */
  upload(bookId: string, chapterTitle: string): Promise<boolean> {
    return this.after(bookId, () => this.service.uploadProgress(bookId, chapterTitle));
  }

  fetch(bookId: string): Promise<ProgressPrompt | null> {
    // One that has not started yet will see whatever arrived meanwhile.
    const waiting = this.queued.get(bookId);
    if (waiting) return waiting;
    const fetched = this.after(bookId, () => {
      if (this.queued.get(bookId) === fetched) this.queued.delete(bookId);
      return this.service.fetchProgress(bookId);
    }).then((prompt) =>
      prompt && this.answered.get(bookId)?.has(promptKey(prompt)) ? null : prompt,
    );
    this.queued.set(bookId, fetched);
    return fetched;
  }

  acknowledge(prompt: ProgressPrompt, bookId: string): Promise<void> {
    const answered = this.answered.get(bookId) ?? new Set<string>();
    answered.add(promptKey(prompt));
    this.answered.set(bookId, answered);
    return this.after(bookId, () =>
      this.service.acknowledgeProgress(bookId, prompt.deviceId, prompt.revision, prompt.locator),
    );
  }
}

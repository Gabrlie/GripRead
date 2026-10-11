import type { SyncService } from "../services/contracts";
import type { ProgressPrompt } from "../types/generated";

/**
 * Orders a book's progress uploads and fetches (Legado 同步阅读进度). A fetch
 * waits for the book's pending upload, so a slow server never answers with
 * the position this device is still sending; the server side also ignores
 * this device's own records.
 */
export class ProgressSync {
  private pending = new Map<string, Promise<unknown>>();

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
    return this.after(bookId, () => this.service.fetchProgress(bookId));
  }

  acknowledge(prompt: ProgressPrompt, bookId: string): Promise<void> {
    return this.after(bookId, () =>
      this.service.acknowledgeProgress(bookId, prompt.deviceId, prompt.revision),
    );
  }
}

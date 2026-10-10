import type { ReaderLocator } from "../types/generated";
import type { ReaderService } from "../services/contracts";

/** Application-owned writes outlive a reader view and never delay opening another book. */
export class ReaderPositions {
  private latest = new Map<string, ReaderLocator>();
  private pending = new Map<string, ReaderLocator>();
  private failures = new Map<string, { locator: ReaderLocator; error: unknown }>();
  private running: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private error: string | null = null;
  constructor(
    private service: Pick<ReaderService, "saveReaderLocator" | "getSavedReaderLocator">,
  ) {}
  getSnapshot = () => this.error;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  errorFor(bookId: string | null) {
    const failure = bookId ? this.failures.get(bookId) : undefined;
    return failure
      ? String(failure.error instanceof Error ? failure.error.message : failure.error)
      : null;
  }
  load(bookId: string): Promise<ReaderLocator | null> {
    return this.latest.has(bookId)
      ? Promise.resolve(this.latest.get(bookId)!)
      : this.service.getSavedReaderLocator(bookId);
  }
  forget(bookId: string) {
    this.latest.delete(bookId);
  }
  queue(locator: ReaderLocator) {
    this.latest.set(locator.bookId, locator);
    this.pending.set(locator.bookId, locator);
    this.start();
  }
  private notify() {
    const failure = this.failures.values().next().value;
    this.error = failure
      ? String(failure.error instanceof Error ? failure.error.message : failure.error)
      : null;
    this.listeners.forEach((listener) => listener());
  }
  private start() {
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.pending.size) this.start();
    });
  }
  private async drain() {
    while (this.pending.size) {
      const [bookId, locator] = this.pending.entries().next().value!;
      this.pending.delete(bookId);
      try {
        await this.service.saveReaderLocator(locator);
        this.failures.delete(bookId);
      } catch (error) {
        this.failures.set(bookId, { locator, error });
      }
      this.notify();
    }
  }
  flush = async () => {
    while (this.running) await this.running;
    for (const [bookId, failure] of this.failures) {
      this.pending.set(bookId, this.latest.get(bookId) ?? failure.locator);
    }
    if (this.pending.size) this.start();
    while (this.running) await this.running;
    if (this.error) throw new Error(this.error);
  };
}

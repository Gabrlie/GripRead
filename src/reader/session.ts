import type { ContentWindow, ReaderLocator } from "../types/generated";
import type { ReaderService } from "../services/ipc";

export type ReaderDirection = "next" | "previous";

/** Coordinates content windows and durable locators without owning UI state. */
export class ReaderSession {
  private currentWindow: ContentWindow | null = null;
  private readonly history: ContentWindow[] = [];
  private requestVersion = 0;

  public constructor(private readonly service: ReaderService) {}

  public get current(): ContentWindow | null {
    return this.currentWindow;
  }

  public async open(bookId: string, maxUnits: number): Promise<ContentWindow> {
    const version = ++this.requestVersion;
    const saved = await this.service.getSavedReaderLocator(bookId);
    const window = await this.service.readContentWindow(bookId, saved, maxUnits);
    if (version !== this.requestVersion) {
      throw new DOMException("A newer reader request superseded this result", "AbortError");
    }
    this.currentWindow = window;
    this.history.length = 0;
    return window;
  }

  public async turn(direction: ReaderDirection, maxUnits: number): Promise<ContentWindow | null> {
    const current = this.currentWindow;
    if (!current || (direction === "next" && !current.hasAfter)) {
      return current;
    }
    if (direction === "previous") {
      // A previous turn is synchronous, but it still supersedes any pending
      // next/open request so a late response cannot replace this state.
      this.requestVersion += 1;
      const previous = this.history.pop();
      if (previous) {
        this.currentWindow = previous;
        return previous;
      }
      return current;
    }

    const version = ++this.requestVersion;
    const nextLocator: ReaderLocator = {
      ...current.locator,
      offset: current.endOffset,
      contextBefore: current.text.slice(-32),
      contextAfter: "",
    };
    const next = await this.service.readContentWindow(current.bookId, nextLocator, maxUnits);
    if (version !== this.requestVersion) {
      throw new DOMException("A newer reader request superseded this result", "AbortError");
    }
    this.history.push(current);
    this.currentWindow = next;
    return next;
  }

  public async save(): Promise<ReaderLocator | null> {
    if (!this.currentWindow) {
      return null;
    }
    return this.service.saveReaderLocator(this.currentWindow.locator);
  }

  public dispose(): void {
    this.requestVersion += 1;
    this.currentWindow = null;
    this.history.length = 0;
  }
}

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { ShelfPreferences } from "../types/generated";
import type { AppServices } from "../services/contracts";
import { LibraryStore } from "./library";
import { ShelfStore } from "./shelf";
import { SettingsStore } from "./settings";
import { ReaderPositions } from "../reader/positions";
import { FontLoader } from "./fonts";
import { ImageLoader } from "./images";
import { ProgressSync } from "./progress-sync";
/** Reading adjustments preview immediately and persist after 800 ms of inactivity. */
export const READER_SETTINGS_SAVE_DELAY_MS = 800;
export class AppRuntime {
  readonly library: LibraryStore;
  readonly shelf: ShelfStore;
  readonly settings: SettingsStore;
  readonly positions: ReaderPositions;
  readonly progressSync: ProgressSync;
  readonly shelfPreferences: SettingsStore<ShelfPreferences>;
  readonly fonts: FontLoader;
  readonly images: ImageLoader;
  readerFlush: (() => Promise<void>) | null = null;
  private readerWrites = new Map<() => Promise<void>, Promise<void>>();
  private failedReaderWrites = new Set<() => Promise<void>>();
  private readerError: string | null = null;
  private readerListeners = new Set<() => void>();
  getReaderError = () => this.readerError;
  subscribeReader = (listener: () => void) => {
    this.readerListeners.add(listener);
    return () => {
      this.readerListeners.delete(listener);
    };
  };
  /** Only accepted reader writes survive leaving; navigation and animation do not. */
  finishReaderWrite = (write: () => Promise<void>) => {
    if (this.readerWrites.has(write)) return;
    const pending = Promise.resolve()
      .then(write)
      .then(
        () => {
          this.failedReaderWrites.delete(write);
          if (!this.failedReaderWrites.size) this.readerError = null;
        },
        (error: unknown) => {
          this.failedReaderWrites.add(write);
          this.readerError = String(error);
        },
      )
      .finally(() => {
        this.readerWrites.delete(write);
        this.readerListeners.forEach((listener) => listener());
      });
    this.readerWrites.set(write, pending);
  };
  retryReaderWrites = () => {
    for (const write of this.failedReaderWrites) this.finishReaderWrite(write);
    void this.positions.flush().catch(() => undefined);
    this.settings.retry();
  };
  constructor(readonly services: AppServices) {
    this.library = new LibraryStore(services.library);
    this.shelf = new ShelfStore(services.library, services.reader, () => this.library.refresh());
    this.settings = new SettingsStore(services.settings, READER_SETTINGS_SAVE_DELAY_MS);
    this.positions = new ReaderPositions(services.reader);
    this.progressSync = new ProgressSync(services.sync);
    this.fonts = new FontLoader(services.settings);
    this.images = new ImageLoader(services.library);
    this.shelfPreferences = new SettingsStore({
      getSettings: services.settings.getShelfPreferences,
      saveSettings: services.settings.saveShelfPreferences,
    });
  }
  flush = async (retryFailed = false) => {
    let firstError: unknown;
    const flushers = [
      this.readerFlush,
      async () => {
        if (retryFailed) for (const write of this.failedReaderWrites) this.finishReaderWrite(write);
        await Promise.all(this.readerWrites.values());
        if (this.readerError) throw new Error(this.readerError);
      },
      this.positions.flush,
      this.settings.flush,
      this.shelfPreferences.flush,
      () => this.library.flush(retryFailed),
      () => this.shelf.flush(retryFailed),
    ];
    for (const flush of flushers) {
      if (!flush) continue;
      try {
        await flush();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };
}
export const RuntimeContext = createContext<AppRuntime | null>(null);
export function useRuntime() {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("RuntimeContext is required");
  return value;
}
export function useLibrary() {
  const store = useRuntime().library;
  return { state: useSyncExternalStore(store.subscribe, store.getSnapshot), store };
}
export function useSettings() {
  const store = useRuntime().settings;
  return { state: useSyncExternalStore(store.subscribe, store.getSnapshot), store };
}

export function useShelf() {
  const store = useRuntime().shelf;
  return { state: useSyncExternalStore(store.subscribe, store.getSnapshot), store };
}

export function useShelfPreferences() {
  const store = useRuntime().shelfPreferences;
  return { state: useSyncExternalStore(store.subscribe, store.getSnapshot), store };
}

/** The object URL of a managed image, or `undefined` while it loads or fails. */
export function useImage(id: string | null | undefined): string | undefined {
  const runtime = useRuntime();
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    runtime.images.load(id).then(
      (url) => !cancelled && setLoaded({ id, url }),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [id, runtime.images]);
  return id && loaded?.id === id ? loaded.url : undefined;
}

import { createContext, useContext, useSyncExternalStore } from "react";
import type { ShelfPreferences } from "../types/generated";
import type { AppServices } from "../services/contracts";
import { LibraryStore } from "./library";
import { ShelfStore } from "./shelf";
import { SettingsStore } from "./settings";
export class AppRuntime {
  readonly library: LibraryStore;
  readonly shelf: ShelfStore;
  readonly settings: SettingsStore;
  readonly shelfPreferences: SettingsStore<ShelfPreferences>;
  readerFlush: (() => Promise<void>) | null = null;
  constructor(readonly services: AppServices) {
    this.library = new LibraryStore(services.library);
    this.shelf = new ShelfStore(services.library, services.reader);
    this.settings = new SettingsStore(services.settings);
    this.shelfPreferences = new SettingsStore({
      getSettings: services.settings.getShelfPreferences,
      saveSettings: services.settings.saveShelfPreferences,
    });
  }
  flush = async (retryFailed = false) => {
    let firstError: unknown;
    const flushers = [
      this.readerFlush,
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

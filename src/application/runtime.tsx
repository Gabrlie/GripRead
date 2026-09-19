import { createContext, useContext, useSyncExternalStore } from "react";
import type { AppServices } from "../services/contracts";
import { LibraryStore } from "./library";
import { ShelfStore } from "./shelf";
import { SettingsStore } from "./settings";
export class AppRuntime {
  readonly library: LibraryStore;
  readonly shelf: ShelfStore;
  readonly settings: SettingsStore;
  readerFlush: (() => Promise<void>) | null = null;
  constructor(readonly services: AppServices) {
    this.library = new LibraryStore(services.library);
    this.shelf = new ShelfStore(services.library, services.reader);
    this.settings = new SettingsStore(services.settings);
  }
  flush = async () => {
    await this.readerFlush?.();
    await this.settings.flush();
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

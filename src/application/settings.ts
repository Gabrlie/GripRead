import type { ReaderPreferences } from "../types/generated";
import type { SettingsService } from "../services/contracts";
export interface SettingsSnapshot {
  value: ReaderPreferences | null;
  error: string | null;
  saving: boolean;
}
export class SettingsStore {
  private snapshot: SettingsSnapshot = { value: null, error: null, saving: false };
  private listeners = new Set<() => void>();
  private pending: ReaderPreferences | null = null;
  private running: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  constructor(private service: SettingsService) {}
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private update(patch: Partial<SettingsSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  load = () => {
    if (this.loading) return this.loading;
    this.loading = this.service
      .getSettings()
      .then((value) => this.update({ value, error: null }))
      .catch((error) => this.update({ error: String(error) }))
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  };
  set = (patch: Partial<ReaderPreferences>) => {
    if (!this.snapshot.value) return;
    this.pending = { ...this.snapshot.value, ...patch };
    this.update({ value: this.pending, saving: true, error: null });
    this.startSave();
  };
  private startSave() {
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.pending && !this.snapshot.error) this.startSave();
    });
  }
  private async drain() {
    while (this.pending) {
      const value = this.pending;
      this.pending = null;
      try {
        await this.service.saveSettings(value);
      } catch (error) {
        this.pending ??= value;
        this.update({ saving: false, error: String(error) });
        return;
      }
    }
    this.update({ saving: false, error: null });
  }
  retry = () => {
    this.update({ error: null, saving: true });
    this.startSave();
  };
  flush = async () => {
    if (!this.snapshot.value) return;
    if (this.running) await this.running;
    if (this.snapshot.error) throw new Error(this.snapshot.error);
  };
}

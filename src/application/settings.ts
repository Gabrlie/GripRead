import type { ReaderPreferences } from "../types/generated";
interface PreferencePort<T> {
  getSettings(): Promise<T>;
  saveSettings(settings: T): Promise<T>;
}
export interface SettingsSnapshot<T = ReaderPreferences> {
  value: T | null;
  error: string | null;
  saving: boolean;
}
export class SettingsStore<T extends object = ReaderPreferences> {
  private snapshot: SettingsSnapshot<T> = { value: null, error: null, saving: false };
  private listeners = new Set<() => void>();
  private pending: T | null = null;
  private running: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  private loadRevision = 0;
  private writeRevision = 0;
  constructor(private service: PreferencePort<T>) {}
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private update(patch: Partial<SettingsSnapshot<T>>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  load = () => {
    if (this.loading) return this.loading;
    const revision = ++this.loadRevision;
    const writeRevision = this.writeRevision;
    const hadPendingWrite = Boolean(this.pending || this.running || this.snapshot.saving);
    this.loading = this.service
      .getSettings()
      .then((value) => {
        // A read that started before a local write must not put stale disk
        // state back into the controls or replace an optimistic value.
        if (
          revision === this.loadRevision &&
          writeRevision === this.writeRevision &&
          !hadPendingWrite &&
          !this.pending &&
          !this.running &&
          !this.snapshot.saving
        )
          this.update({ value, error: null });
      })
      .catch((error) => {
        if (
          revision === this.loadRevision &&
          writeRevision === this.writeRevision &&
          !hadPendingWrite &&
          !this.pending &&
          !this.running
        )
          this.update({ error: String(error) });
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  };
  set = (patch: Partial<T>) => {
    if (!this.snapshot.value) return;
    this.writeRevision++;
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
        const saved = await this.service.saveSettings(value);
        if (!this.pending && this.snapshot.value === value) this.update({ value: saved });
      } catch (error) {
        this.pending ??= value;
        this.update({ saving: false, error: String(error) });
        return;
      }
    }
    this.update({ saving: false, error: null });
  }
  retry = () => {
    if (!this.pending) {
      void this.load();
      return;
    }
    this.update({ error: null, saving: true });
    this.startSave();
  };
  flush = async () => {
    if (!this.snapshot.value) return;
    while (this.running || (this.pending && !this.snapshot.error)) {
      if (!this.running) this.startSave();
      const running = this.running;
      if (running) await running;
    }
    if (this.snapshot.error) throw new Error(this.snapshot.error);
  };
}

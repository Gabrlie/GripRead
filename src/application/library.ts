import type { ImportStatus, LibraryBook } from "../types/generated";
import type { LibraryService, Unsubscribe } from "../services/contracts";

export interface LibrarySnapshot {
  books: LibraryBook[];
  loading: boolean;
  error: string | null;
  job: ImportStatus | null;
  importing: boolean;
  importError: string | null;
}
export const isTerminal = (status: ImportStatus) =>
  ["completed", "failed", "cancelled"].includes(status.phase);

/** Owns the import across page/panel lifetimes. Events and polling share one terminal transition. */
export class LibraryStore {
  private snapshot: LibrarySnapshot = {
    books: [],
    loading: true,
    error: null,
    job: null,
    importing: false,
    importError: null,
  };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unlisten: Unsubscribe | undefined;
  private generation = 0;
  private refreshVersion = 0;
  private operationId: string | null = null;
  private completed = new Set<string>();
  constructor(private service: LibraryService) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<LibrarySnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  connect = () => {
    const generation = ++this.generation;
    void this.refresh();
    void this.service
      .onImportProgress((status) => {
        if (generation === this.generation) this.accept(status);
      })
      .then((unlisten) => {
        if (generation !== this.generation) unlisten();
        else this.unlisten = unlisten;
      })
      .catch(() => {
        /* Polling is authoritative when event registration is unavailable. */
      });
    if (this.operationId && this.snapshot.importing) void this.poll(generation);
    return () => {
      if (generation !== this.generation) return;
      this.generation++;
      this.unlisten?.();
      this.unlisten = undefined;
      clearTimeout(this.timer);
    };
  };
  refresh = async () => {
    const version = ++this.refreshVersion;
    this.update({ loading: true, error: null });
    try {
      const books = await this.service.listBooks();
      if (version === this.refreshVersion) this.update({ books, loading: false });
    } catch (error) {
      if (version === this.refreshVersion) this.update({ loading: false, error: String(error) });
    }
  };
  importTxt = async (path?: string) => {
    if (this.snapshot.importing) return;
    this.update({ importing: true, importError: null, job: null });
    try {
      const task =
        path === undefined
          ? await this.service.pickAndImportTxt()
          : await this.service.startImport(path);
      if (!task) {
        this.update({ importing: false });
        return;
      }
      this.operationId = task.operationId;
      await this.poll(this.generation);
    } catch (error) {
      this.update({ importing: false, importError: String(error) });
    }
  };
  cancel = async () => {
    if (!this.operationId || !this.snapshot.importing) return;
    try {
      await this.service.cancelImport(this.operationId);
    } catch (error) {
      this.update({ importError: String(error) });
    }
  };
  private accept(status: ImportStatus) {
    if (status.operationId !== this.operationId || this.completed.has(status.operationId)) return;
    if (status.phase === "completed" && !status.result) {
      const message = "导入服务返回了缺少结果的完成状态，请重试查询。";
      const failed: ImportStatus = {
        ...status,
        phase: "failed",
        result: null,
        error: { code: "io", message },
      };
      this.update({ job: failed, importing: false, importError: message });
      this.completed.add(status.operationId);
      clearTimeout(this.timer);
      return;
    }
    this.update({
      job: status,
      importing: !isTerminal(status),
      importError: status.error ? `${status.error.code}: ${status.error.message}` : null,
    });
    if (isTerminal(status)) {
      this.completed.add(status.operationId);
      clearTimeout(this.timer);
      if (status.phase === "completed") void this.refresh();
    }
  }
  private async poll(generation: number) {
    const id = this.operationId;
    if (!id || generation !== this.generation) return;
    try {
      const status = await this.service.getImportStatus(id);
      if (generation === this.generation && id === this.operationId) this.accept(status);
    } catch (error) {
      if (generation === this.generation && id === this.operationId && !this.completed.has(id))
        this.update({ importError: String(error) });
    }
    if (generation === this.generation && id === this.operationId && this.snapshot.importing)
      this.timer = setTimeout(() => {
        void this.poll(generation);
      }, 250);
  }
}

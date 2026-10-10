import type {
  UpdateBookRequest,
  ShelfSort,
  ImportStatus,
  ImportPhase,
  LibraryBook,
  TxtDecodeStatus,
  TxtEncoding,
  TxtEncodingInfo,
} from "../types/generated";
import type { LibraryService, Unsubscribe } from "../services/contracts";

export interface LibrarySnapshot {
  books: LibraryBook[];
  removedBooks: LibraryBook[];
  removedLoading: boolean;
  removedLoaded: boolean;
  managementError: string | null;
  managing: boolean;
  lastRemoved: { id: string; title: string } | null;
  loading: boolean;
  error: string | null;
  job: ImportStatus | null;
  importing: boolean;
  /** Progress of a several-file or folder import, while it runs. */
  batch: { total: number; done: number; failed: number } | null;
  importError: string | null;
  importOutcome: ImportOutcome | null;
  importNotice: ImportNotice | null;
  importDetailsRequested: boolean;
  decodeJob: TxtDecodeStatus | null;
  decoding: boolean;
  decodeError: string | null;
}

export interface ImportOutcome {
  phase: "completed" | "failed" | "cancelled";
  status: ImportStatus | null;
  error: string | null;
  retryWithEncoding: boolean;
}

export interface ImportNotice {
  id: number;
  phase: ImportOutcome["phase"];
  message: string;
}

export const isTerminal = (status: { phase: ImportPhase }) =>
  ["completed", "failed", "cancelled"].includes(status.phase);

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:^|\s)([a-z][a-z0-9_]*)\s*:/i);
  return match?.[1];
}

function isValidationError(error: unknown): boolean {
  return errorCode(error) === "invalid_argument" || errorCode(error) === "not_found";
}

interface FailedWrite {
  revision: number;
  error: unknown;
  retry: (() => Promise<unknown>) | null;
}

/** Owns the import across page/panel lifetimes. Events and polling share one terminal transition. */
export class LibraryStore {
  private snapshot: LibrarySnapshot = {
    books: [],
    removedBooks: [],
    removedLoading: false,
    removedLoaded: false,
    managementError: null,
    managing: false,
    lastRemoved: null,
    loading: true,
    error: null,
    job: null,
    importing: false,
    batch: null,
    importError: null,
    importOutcome: null,
    importNotice: null,
    importDetailsRequested: false,
    decodeJob: null,
    decoding: false,
    decodeError: null,
  };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unlisten: Unsubscribe | undefined;
  private unlistenDecode: Unsubscribe | undefined;
  private generation = 0;
  private refreshVersion = 0;
  private operationId: string | null = null;
  private completed = new Set<string>();
  private importAttempt = 0;
  private noticeRevision = 0;
  private noticeTimerRevision = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeRemainingMs = 0;
  private noticeDeadline = 0;
  private decodeOperationId: string | null = null;
  private decodeTimer: ReturnType<typeof setTimeout> | undefined;
  private decodeWaiter:
    { resolve: (value: TxtEncodingInfo) => void; reject: (error: unknown) => void } | undefined;
  /** Resolves when the current single import reaches a terminal state. */
  private settle: (() => void) | undefined;
  private batchCancelled = false;
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
  private stopNoticeTimer() {
    this.noticeTimerRevision++;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
  }
  private scheduleNoticeDismissal(id: number, delayMs: number) {
    this.noticeTimerRevision++;
    const timerRevision = this.noticeTimerRevision;
    this.noticeRemainingMs = delayMs;
    this.noticeDeadline = Date.now() + delayMs;
    this.noticeTimer = setTimeout(() => {
      if (timerRevision !== this.noticeTimerRevision || this.snapshot.importNotice?.id !== id)
        return;
      this.noticeTimer = undefined;
      this.noticeRemainingMs = 0;
      this.update({ importNotice: null });
    }, delayMs);
  }
  private showImportNotice(phase: ImportOutcome["phase"], message: string, durationMs: number) {
    this.stopNoticeTimer();
    const id = ++this.noticeRevision;
    this.update({ importNotice: { id, phase, message } });
    this.scheduleNoticeDismissal(id, durationMs);
  }
  dismissImportNotice = (id: number) => {
    if (this.snapshot.importNotice?.id !== id) return;
    this.stopNoticeTimer();
    this.noticeRemainingMs = 0;
    this.update({ importNotice: null });
  };
  pauseImportNotice = (id: number) => {
    if (this.snapshot.importNotice?.id !== id || !this.noticeTimer) return;
    this.noticeRemainingMs = Math.max(0, this.noticeDeadline - Date.now());
    this.stopNoticeTimer();
  };
  resumeImportNotice = (id: number) => {
    if (this.snapshot.importNotice?.id !== id || this.noticeTimer) return;
    const remaining = this.noticeRemainingMs;
    if (remaining <= 0) {
      this.dismissImportNotice(id);
      return;
    }
    this.scheduleNoticeDismissal(id, remaining);
  };
  private clearImportNotice() {
    this.stopNoticeTimer();
    this.noticeRemainingMs = 0;
    if (this.snapshot.importNotice) this.update({ importNotice: null });
  }
  requestImportDetails = () => this.update({ importDetailsRequested: true });
  consumeImportDetailsRequest = () => {
    if (this.snapshot.importDetailsRequested) this.update({ importDetailsRequested: false });
  };
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
    void this.service
      .onTxtDecodeProgress((status) => {
        if (generation === this.generation) this.acceptDecode(status);
      })
      .then((unlisten) => {
        if (generation !== this.generation) unlisten();
        else this.unlistenDecode = unlisten;
      })
      .catch(() => {
        /* Polling remains authoritative when event registration is unavailable. */
      });
    if (this.operationId && this.snapshot.importing) void this.poll(generation);
    if (this.decodeOperationId && this.snapshot.decoding) void this.pollDecode(generation);
    return () => {
      if (generation !== this.generation) return;
      this.generation++;
      this.unlisten?.();
      this.unlisten = undefined;
      this.unlistenDecode?.();
      this.unlistenDecode = undefined;
      clearTimeout(this.timer);
      clearTimeout(this.decodeTimer);
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
  private managementQueue: Promise<void> = Promise.resolve();
  private pendingChanges = 0;
  private removedRevision = 0;
  private pendingWrites = new Set<Promise<void>>();
  private writeRevision = 0;
  private failedWrites = new Map<string, FailedWrite>();
  loadRemoved = async () => {
    const revision = ++this.removedRevision;
    this.update({ removedLoading: true, managementError: null });
    try {
      const removedBooks = await this.service.listRemovedBooks();
      if (revision === this.removedRevision)
        this.update({ removedBooks, removedLoading: false, removedLoaded: true });
    } catch (error) {
      if (revision === this.removedRevision)
        this.update({ removedLoading: false, removedLoaded: true, managementError: String(error) });
    }
  };
  private manage(key: string, action: () => Promise<unknown>): Promise<void> {
    this.pendingChanges++;
    this.update({ managing: true });
    const revision = ++this.writeRevision;
    let resolveWrite!: () => void;
    let rejectWrite!: (error: unknown) => void;
    const write = new Promise<void>((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    });
    this.pendingWrites.add(write);
    void write.catch(() => undefined).finally(() => this.pendingWrites.delete(write));
    const pending = this.managementQueue.then(async () => {
      ++this.refreshVersion;
      ++this.removedRevision;
      this.update({ managementError: null });
      try {
        try {
          await action();
          const previous = this.failedWrites.get(key);
          if (previous && previous.revision < revision) this.failedWrites.delete(key);
          resolveWrite();
        } catch (error) {
          if (!isValidationError(error)) {
            this.failedWrites.set(key, { revision, error, retry: action });
          }
          rejectWrite(error);
          throw error;
        }
        await this.refresh();
        await this.loadRemoved();
        if (this.snapshot.error || this.snapshot.managementError)
          throw new Error(this.snapshot.error ?? this.snapshot.managementError!);
      } catch (error) {
        // The pre-mutation refresh was invalidated so it cannot put an older
        // snapshot back into the shelf. Surface the failure while releasing
        // both loading indicators instead of leaving a spinner forever.
        this.update({
          loading: false,
          removedLoading: false,
          managementError: String(error),
        });
        throw error;
      } finally {
        this.pendingChanges--;
        this.update({ managing: this.pendingChanges > 0 });
      }
    });
    this.managementQueue = pending.catch(() => undefined);
    return pending;
  }
  hasUnresolvedWrites = () => this.failedWrites.size > 0;
  discardFailedWrites = () => {
    // Explicit cancellation abandons only rejected intents; pending writes and
    // committed records are never touched.
    this.failedWrites.clear();
  };
  flush = async (retryFailed = false) => {
    for (;;) {
      const writes = [...this.pendingWrites];
      if (writes.length) await Promise.allSettled(writes);
      if (this.pendingWrites.size) continue;
      const failures = [...this.failedWrites.entries()];
      if (!failures.length) return;
      if (!retryFailed) throw failures[0][1].error;
      for (const [key, failure] of failures) {
        if (this.failedWrites.get(key)?.revision !== failure.revision) continue;
        if (!failure.retry) throw failure.error;
        this.failedWrites.delete(key);
        try {
          await failure.retry();
        } catch (error) {
          const newer = this.failedWrites.get(key);
          if (!newer || newer.revision <= failure.revision)
            this.failedWrites.set(key, { ...failure, error });
          throw error;
        }
      }
    }
  };
  edit = (request: UpdateBookRequest) =>
    this.manage(`book:${request.bookId}:metadata`, () => this.service.updateBook(request));
  remove = (book: LibraryBook) =>
    this.manage(`book:${book.book.id}:shelf`, async () => {
      await this.service.removeBook(book.book.id);
      this.update({ lastRemoved: { id: book.book.id, title: book.book.title } });
    });
  restore = (id: string) =>
    this.manage(`book:${id}:shelf`, async () => {
      await this.service.restoreBook(id);
      if (this.snapshot.lastRemoved?.id === id) this.update({ lastRemoved: null });
    });
  dismissUndo = () => this.update({ lastRemoved: null });
  /** Picks several TXT files and imports them one after another. */
  importFiles = async () => {
    if (this.snapshot.importing || this.snapshot.batch) return;
    try {
      const paths = await this.service.pickTxtFiles();
      if (paths.length === 1) return this.importTxt(paths[0]);
      await this.importBatch(paths);
    } catch (error) {
      this.update({ importError: String(error) });
      this.showImportNotice("failed", "导入失败", 8_000);
    }
  };
  /** Picks a folder and imports every TXT file in it. */
  importFolder = async () => {
    if (this.snapshot.importing || this.snapshot.batch) return;
    try {
      const files = await this.service.pickTxtFolder();
      if (!files.length) return;
      await this.importBatch(files.map((file) => file.path));
    } catch (error) {
      this.update({ importError: String(error) });
      this.showImportNotice("failed", "文件夹读取失败", 8_000);
    }
  };
  importBatch = async (paths: string[]) => {
    if (!paths.length || this.snapshot.batch) return;
    this.batchCancelled = false;
    let done = 0;
    let failed = 0;
    this.update({ batch: { total: paths.length, done, failed } });
    for (const path of paths) {
      if (this.batchCancelled) break;
      const finished = new Promise<void>((resolve) => (this.settle = resolve));
      await this.importTxt(path);
      if (!this.snapshot.importing) this.finishSettle();
      await finished;
      done += 1;
      if (this.snapshot.importOutcome?.phase !== "completed") failed += 1;
      this.update({ batch: { total: paths.length, done, failed } });
    }
    this.update({ batch: null });
    const imported = done - failed;
    this.showImportNotice(
      failed ? "failed" : "completed",
      failed ? `已导入 ${imported} 本，${failed} 本失败` : `已导入 ${imported} 本`,
      failed ? 8_000 : 3_000,
    );
  };
  private finishSettle() {
    const settle = this.settle;
    this.settle = undefined;
    settle?.();
  }
  importTxt = async (path?: string, encoding?: TxtEncoding) => {
    if (this.snapshot.importing) return;
    const attempt = ++this.importAttempt;
    this.clearImportNotice();
    this.operationId = null;
    clearTimeout(this.timer);
    this.update({ importing: true, importError: null, job: null });
    try {
      const task =
        path === undefined
          ? await this.service.pickAndImportTxt(encoding)
          : await this.service.startImport(path, encoding);
      if (attempt !== this.importAttempt) return;
      if (!task) {
        // Closing the native picker is not an import failure. Keep the last
        // terminal result available through the status entry.
        this.update({ importing: false, importError: null });
        return;
      }
      this.operationId = task.operationId;
      await this.poll(this.generation);
    } catch (error) {
      if (attempt !== this.importAttempt) return;
      const message = String(error);
      const retryWithEncoding =
        errorCode(error) === "unsupported_encoding" &&
        (encoding === undefined || encoding === "auto");
      this.update({
        importing: false,
        importError: message,
        importOutcome: {
          phase: "failed",
          status: null,
          error: message,
          retryWithEncoding,
        },
      });
      this.showImportNotice("failed", "导入失败", 8_000);
    }
  };
  cancel = async () => {
    this.batchCancelled = true;
    const id = this.operationId;
    if (!id || !this.snapshot.importing) return;
    try {
      await this.service.cancelImport(id);
    } catch (error) {
      if (id === this.operationId && this.snapshot.importing && !this.completed.has(id))
        this.update({ importError: String(error) });
    }
  };
  decodeTxt = (bookId: string, encoding: TxtEncoding): Promise<TxtEncodingInfo> => {
    if (this.snapshot.decoding) return Promise.reject(new Error("TXT 编码转换正在进行"));
    this.update({ decoding: true, decodeError: null, decodeJob: null });
    return new Promise<TxtEncodingInfo>((resolve, reject) => {
      this.decodeWaiter = { resolve, reject };
      void this.service
        .startTxtDecode({ bookId, encoding })
        .then((task) => {
          this.decodeOperationId = task.operationId;
          void this.pollDecode(this.generation);
        })
        .catch((error) => {
          this.decodeWaiter = undefined;
          this.update({ decoding: false, decodeError: String(error) });
          reject(error);
        });
    });
  };
  cancelDecode = async () => {
    if (!this.decodeOperationId || !this.snapshot.decoding) return;
    try {
      await this.service.cancelTxtDecode(this.decodeOperationId);
    } catch (error) {
      this.update({ decodeError: String(error) });
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
      this.update({
        job: failed,
        importing: false,
        importError: message,
        importOutcome: {
          phase: "failed",
          status: failed,
          error: message,
          retryWithEncoding: false,
        },
      });
      this.completed.add(status.operationId);
      clearTimeout(this.timer);
      this.showImportNotice("failed", "导入失败", 8_000);
      this.finishSettle();
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
      const phase = status.phase as ImportOutcome["phase"];
      const message = status.error
        ? `${status.error.code}: ${status.error.message}`
        : phase === "failed"
          ? "导入失败，请重新选择文件后重试。"
          : null;
      const retryWithEncoding = phase === "failed" && status.error?.code === "unsupported_encoding";
      this.update({
        importOutcome: {
          phase,
          status,
          error: message,
          retryWithEncoding,
        },
      });
      if (phase === "completed") {
        this.showImportNotice("completed", "导入完成", 3_000);
      } else if (phase === "failed") {
        this.showImportNotice("failed", "导入失败", 8_000);
      } else {
        this.showImportNotice("cancelled", "导入已取消", 2_500);
      }
      if (status.phase === "completed") {
        if (status.result && this.snapshot.lastRemoved?.id === status.result.book.id)
          this.update({ lastRemoved: null });
        void this.refresh();
        void this.loadRemoved();
      }
      this.finishSettle();
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
  private acceptDecode(status: TxtDecodeStatus) {
    if (status.operationId !== this.decodeOperationId) return;
    this.update({
      decodeJob: status,
      decoding: !isTerminal(status),
      decodeError: status.error ? `${status.error.code}: ${status.error.message}` : null,
    });
    if (!isTerminal(status)) return;
    clearTimeout(this.decodeTimer);
    this.decodeOperationId = null;
    const waiter = this.decodeWaiter;
    this.decodeWaiter = undefined;
    if (status.phase === "completed" && status.result) waiter?.resolve(status.result);
    else waiter?.reject(new Error(status.error?.message ?? "TXT 编码转换未完成"));
  }
  private async pollDecode(generation: number) {
    const id = this.decodeOperationId;
    if (!id || generation !== this.generation) return;
    try {
      const status = await this.service.getTxtDecodeStatus(id);
      if (generation === this.generation && id === this.decodeOperationId)
        this.acceptDecode(status);
    } catch (error) {
      if (generation === this.generation && id === this.decodeOperationId) {
        this.update({ decodeError: String(error) });
      }
    }
    if (generation === this.generation && id === this.decodeOperationId && this.snapshot.decoding) {
      this.decodeTimer = setTimeout(() => void this.pollDecode(generation), 250);
    }
  }
}

const titleOrder = new Intl.Collator("zh-Hans", { numeric: true, sensitivity: "base" });
export function orderBooks(books: readonly LibraryBook[], sort: ShelfSort): LibraryBook[] {
  return [...books].sort((a, b) => {
    const primary =
      sort === "title"
        ? titleOrder.compare(a.book.title, b.book.title)
        : sort === "recent_read"
          ? (b.lastReadAt ?? -1) - (a.lastReadAt ?? -1)
          : b.book.createdAt - a.book.createdAt;
    return primary || b.book.createdAt - a.book.createdAt || a.book.id.localeCompare(b.book.id);
  });
}

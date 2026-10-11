import { vi } from "vitest";
import type { SyncService } from "../services/contracts";

/** A sync service without a WebDAV account, as on a fresh install. */
export function syncServiceMocks(): SyncService {
  const unconfigured = () => Promise.reject(new Error("invalid_argument: WebDAV is not set up"));
  return {
    getWebDav: vi.fn(async () => ({
      url: "",
      username: "",
      hasPassword: false,
      autoBackup: false,
      lastBackupAt: null,
      lastError: null,
    })),
    saveWebDav: vi.fn(unconfigured),
    testWebDav: vi.fn(unconfigured),
    backupNow: vi.fn(unconfigured),
    runAutomaticBackup: vi.fn(async () => null),
    listBackups: vi.fn(unconfigured),
    deleteBackup: vi.fn(unconfigured),
    listRecoveryPoints: vi.fn(async () => []),
    pickBackupFile: vi.fn(async () => null),
    previewBackup: vi.fn(unconfigured),
    restoreBackup: vi.fn(unconfigured),
    exportBackupFile: vi.fn(async () => false),
    listCloudBooks: vi.fn(unconfigured),
    uploadBooks: vi.fn(unconfigured),
    downloadCloudBook: vi.fn(unconfigured),
    deleteCloudBook: vi.fn(unconfigured),
  };
}

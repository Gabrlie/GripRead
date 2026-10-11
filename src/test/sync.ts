import { vi } from "vitest";
import type { SyncService } from "../services/contracts";
import type { WebDavSettings } from "../types/generated";

export function unconfiguredWebDav(): WebDavSettings {
  return {
    url: "",
    username: "",
    hasPassword: false,
    folder: "",
    deviceName: "",
    localFolder: null,
    autoBackup: false,
    syncProgress: true,
    syncProgressPlus: false,
    restoreIgnore: [],
    lastBackupAt: null,
    lastError: null,
    configured: false,
  };
}

/** A sync service without a WebDAV account, as on a fresh install. */
export function syncServiceMocks(): SyncService {
  const unconfigured = () => Promise.reject(new Error("invalid_argument: WebDAV is not set up"));
  return {
    getWebDav: vi.fn(async () => unconfiguredWebDav()),
    setBackupFolder: vi.fn(async () => unconfiguredWebDav()),
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
    uploadProgress: vi.fn(async () => false),
    fetchProgress: vi.fn(async () => null),
    acknowledgeProgress: vi.fn(async () => undefined),
  };
}

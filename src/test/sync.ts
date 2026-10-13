import { vi } from "vitest";
import type { SyncService } from "../services/contracts";
import type { SyncServerStatus, WebDavSettings } from "../types/generated";

export function unconfiguredWebDav(): WebDavSettings {
  return {
    url: "",
    username: "",
    password: "",
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

export function disconnectedServer(): SyncServerStatus {
  return {
    connected: false,
    address: "",
    deviceName: "",
    syncing: false,
    lastSync: null,
    lastError: null,
    autoDownload: true,
  };
}

/** A sync service without a WebDAV account, as on a fresh install. */
export function syncServiceMocks(): SyncService {
  let server = disconnectedServer();
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
    getServer: vi.fn(async () => server),
    connectServer: vi.fn(async (request) => {
      server = {
        ...server,
        connected: true,
        address: request.address,
        deviceName: request.deviceName,
      };
      return server;
    }),
    disconnectServer: vi.fn(async () => (server = disconnectedServer())),
    syncServerNow: vi.fn(async () => undefined),
    setServerAutoDownload: vi.fn(async (on) => (server = { ...server, autoDownload: on })),
    setSyncOpenBook: vi.fn(async () => undefined),
    onServerStatus: vi.fn(async () => () => undefined),
    onSyncApplied: vi.fn(async () => () => undefined),
    onSyncProgress: vi.fn(async () => () => undefined),
  };
}

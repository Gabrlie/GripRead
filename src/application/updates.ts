import type { UpdateService } from "../services/contracts";
import type {
  AvailableUpdate,
  InstallOutcome,
  UpdateCheck,
  UpdateSettings,
} from "../types/generated";

/** 自动检查更新 runs at most this often, when the app starts. */
export const AUTO_CHECK_EVERY_MS = 24 * 3600 * 1000;

export function autoCheckDue(settings: UpdateSettings, now = Date.now()): boolean {
  return (
    settings.autoCheck &&
    (settings.lastCheck === null || now - settings.lastCheck >= AUTO_CHECK_EVERY_MS)
  );
}

/** The update to prompt for: newer, and not a version the reader skipped. */
export function promptFor(check: UpdateCheck, settings: UpdateSettings): AvailableUpdate | null {
  const update = check.update;
  if (!update || update.version === settings.skipped) return null;
  // The web version cannot install; it only mentions the server image.
  if (check.kind === "server") return null;
  return update;
}

export function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface InstallProgress {
  received: number;
  total: number | null;
}

/**
 * Downloads and installs `version`, reporting progress until the installer
 * opens. `signal` cancels the download.
 */
export async function installUpdate(
  service: UpdateService,
  version: string,
  onProgress: (progress: InstallProgress) => void,
  signal?: AbortSignal,
): Promise<InstallOutcome> {
  const operationId = `update-${Date.now()}`;
  const unsubscribe = await service.onProgress((progress) => {
    if (progress.operationId === operationId)
      onProgress({ received: progress.received, total: progress.total });
  });
  const cancel = () => void service.cancel(operationId);
  signal?.addEventListener("abort", cancel);
  try {
    return await service.install(operationId, version);
  } finally {
    signal?.removeEventListener("abort", cancel);
    unsubscribe();
  }
}

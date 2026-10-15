/** Display helpers for backups and cloud books. */
import { formatDateTime, t } from "../../i18n";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(millis: number | null | undefined): string {
  if (!millis) return t("common.unknownTime");
  return formatDateTime(millis);
}

/** Service errors arrive as `code: message`; show the message in Chinese where known. */
export function describeError(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error);
  const message = text.replace(/^[a-z_]+:\s*/, "");
  if (/WebDAV is not set up/.test(message)) return t("error.webdavUnset");
  if (/\((401|403)\)/.test(message)) return t("error.webdavAuth");
  if (/\(404\)/.test(message)) return t("error.webdavMissing");
  if (/\(507\)/.test(message)) return t("error.webdavFull");
  if (/must start with https/.test(message)) return t("error.address");
  if (/request failed/.test(message)) return t("error.webdavUnreachable", { message });
  if (/not a GripRead backup/.test(message)) return t("error.notBackup");
  if (/newer version/.test(message)) return t("error.newerBackup");
  return message;
}

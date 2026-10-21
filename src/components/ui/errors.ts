import { errorText, t } from "../../i18n";

/** Service errors arrive as `code: message`; show the message in Chinese where known. */
export function describeError(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? errorText(error as { message: string; key?: string; params?: Record<string, string> })
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

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

export { describeError } from "../ui/errors";

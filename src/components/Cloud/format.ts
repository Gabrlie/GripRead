/** Display helpers for backups and cloud books. */

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(millis: number | null | undefined): string {
  if (!millis) return "时间未知";
  return new Date(millis).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  if (/WebDAV is not set up/.test(message)) return "还没有设置 WebDAV 账号。";
  if (/\((401|403)\)/.test(message)) return "WebDAV 账号或密码不正确。";
  if (/\(404\)/.test(message)) return "WebDAV 地址不存在，请检查服务器地址。";
  if (/\(507\)/.test(message)) return "WebDAV 空间不足。";
  if (/must start with https/.test(message)) return "服务器地址需要以 https:// 或 http:// 开头。";
  if (/request failed/.test(message)) return `无法连接 WebDAV：${message}`;
  if (/not a GripRead backup/.test(message)) return "这不是 GripRead 的备份文件。";
  if (/newer version/.test(message)) return "这个备份来自更新版本的 GripRead，请先升级。";
  return message;
}

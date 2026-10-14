/** A publication time as the article list shows it. */
export function articleTime(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(at);
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : date.toLocaleDateString("zh-CN");
}

/** The site name of an address, for feeds without a title. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

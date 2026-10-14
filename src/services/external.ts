import { native } from "./transport";

/** Opens a web page in the system browser (the app) or a new tab (the web version). */
export async function openExternal(url: string): Promise<void> {
  if (native) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

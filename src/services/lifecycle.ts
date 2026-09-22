import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** A failed flush leaves the app open, for both window close and native Quit. */
export async function listenForClose(
  flush: (retryFailed?: boolean) => Promise<void>,
  onError: (error: unknown, retry: () => Promise<void>) => void,
  onPendingChange: (pending: boolean) => void = () => undefined,
) {
  if (!isTauri()) return () => undefined;
  const window = getCurrentWindow();
  let closing = false;
  let disposed = false;
  let exitRequested = false;
  const finish = async (exit: boolean, retryFailed = false) => {
    if (disposed) return;
    if (closing) {
      // Quit may arrive while a window-close flush is pending. Keep the
      // stronger intent without starting another persistence operation.
      exitRequested ||= exit;
      return;
    }
    closing = true;
    exitRequested = exit;
    onPendingChange(true);
    try {
      await flush(retryFailed);
      // A disposed listener no longer owns the window, even when its save
      // finishes after a replacement listener has been installed.
      if (disposed) return;
      if (exitRequested) await invoke("complete_exit");
      else await window.destroy();
    } catch (error) {
      if (disposed) return;
      closing = false;
      onPendingChange(false);
      const retryExit = exitRequested;
      onError(error, () => finish(retryExit, true));
    }
  };
  const unclose = await window.onCloseRequested((event) => {
    event.preventDefault();
    void finish(false);
  });
  try {
    const unexit = await listen("app-exit-requested", () => {
      void finish(true);
    });
    return () => {
      disposed = true;
      unclose();
      unexit();
    };
  } catch (error) {
    disposed = true;
    onPendingChange(false);
    unclose();
    throw error;
  }
}

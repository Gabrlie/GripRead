import { isTauri, invoke } from "@tauri-apps/api/core";
import { onBackButtonPress } from "@tauri-apps/api/app";
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

/**
 * Android pauses a hidden app and may kill it without a close or exit request,
 * so ordered saves run when the document is hidden. Each writer retains its own
 * failure and retry state; the callback only reports that this attempt failed.
 */
export function flushWhenHidden(flush: () => Promise<void>, onError: (error: unknown) => void) {
  const hidden = () => {
    if (document.visibilityState === "hidden") void flush().catch(onError);
  };
  document.addEventListener("visibilitychange", hidden);
  return () => document.removeEventListener("visibilitychange", hidden);
}

/**
 * Android back closes the topmost layer, then returns to the first tab, then
 * asks Rust to exit through the same ordered-save handshake as native Quit.
 * Each step returns whether it consumed the press.
 */
export async function listenForBack(steps: Array<() => boolean>) {
  if (!isTauri() || !/Android/i.test(navigator.userAgent)) return () => undefined;
  const listener = await onBackButtonPress(() => {
    if (steps.some((step) => step())) return;
    void invoke("request_exit").catch((error: unknown) =>
      console.error("Exit request failed", error),
    );
  });
  return () => void listener.unregister();
}

/** Quits the app through the ordered-save handshake; false where a page cannot quit (the web version). */
export function requestExit(): boolean {
  if (!isTauri()) return false;
  void invoke("request_exit").catch((error: unknown) =>
    console.error("Exit request failed", error),
  );
  return true;
}

/** Dismisses an open dialog or the reader through its existing Escape handling. */
export function dismissWithEscape(target: Element) {
  return target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

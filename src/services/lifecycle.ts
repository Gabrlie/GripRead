import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** A failed flush leaves the app open, for both window close and native Quit. */
export async function listenForClose(
  flush: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  if (!isTauri()) return () => undefined;
  const window = getCurrentWindow();
  let closing = false;
  const finish = async (exit: boolean) => {
    if (closing) return;
    closing = true;
    try {
      await flush();
      if (exit) await invoke("complete_exit");
      else await window.destroy();
    } catch (error) {
      closing = false;
      onError(error);
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
      unclose();
      unexit();
    };
  } catch (error) {
    unclose();
    throw error;
  }
}

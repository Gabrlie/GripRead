// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
const fakes = vi.hoisted(() => ({
  onClose: vi.fn(),
  listen: vi.fn(),
  invoke: vi.fn(),
  destroy: vi.fn(),
  onBack: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({ onBackButtonPress: fakes.onBack }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: fakes.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: fakes.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: fakes.onClose, destroy: fakes.destroy }),
}));
import { flushWhenHidden, listenForBack, listenForClose } from "./lifecycle";
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  fakes.onClose.mockResolvedValue(vi.fn());
  fakes.listen.mockResolvedValue(vi.fn());
});
describe("native exit persistence", () => {
  it("prevents closing until flush succeeds, and allows retry after a real error", async () => {
    const failure = new Error("database write failed");
    const flush = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const error = vi.fn();
    await listenForClose(flush, error);
    const close = fakes.onClose.mock.calls[0][0];
    const event = { preventDefault: vi.fn() };
    close(event);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure, expect.any(Function)));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(fakes.destroy).not.toHaveBeenCalled();
    close(event);
    await vi.waitFor(() => expect(fakes.destroy).toHaveBeenCalledOnce());
  });
  it("flushes native Quit before acknowledging the Rust exit request", async () => {
    let complete!: () => void;
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    await listenForClose(flush, vi.fn());
    fakes.listen.mock.calls[0][1]();
    expect(fakes.invoke).not.toHaveBeenCalled();
    complete();
    await vi.waitFor(() => expect(fakes.invoke).toHaveBeenCalledWith("complete_exit"));
  });
  it("coalesces duplicate requests and upgrades pending window close to Quit", async () => {
    const save = deferred();
    const flush = vi.fn(() => save.promise);
    const pending = vi.fn();
    await listenForClose(flush, vi.fn(), pending);
    const close = fakes.onClose.mock.calls[0][0];
    const quit = fakes.listen.mock.calls[0][1];
    const event = { preventDefault: vi.fn() };
    close(event);
    close(event);
    quit();
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(fakes.invoke).not.toHaveBeenCalled();
    save.resolve();
    await vi.waitFor(() => expect(fakes.invoke).toHaveBeenCalledOnce());
    expect(fakes.invoke).toHaveBeenCalledWith("complete_exit");
    expect(fakes.destroy).not.toHaveBeenCalled();
  });
  it("unblocks the window on failure and exposes a retry for the original Quit intent", async () => {
    const failure = new Error("save-position fault");
    const save = deferred();
    const flush = vi.fn().mockRejectedValueOnce(failure).mockReturnValueOnce(save.promise);
    const error = vi.fn();
    const pending = vi.fn();
    await listenForClose(flush, error, pending);
    fakes.listen.mock.calls[0][1]();
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(pending.mock.calls.map(([value]) => value)).toEqual([true, false]);
    expect(fakes.invoke).not.toHaveBeenCalled();
    expect(fakes.destroy).not.toHaveBeenCalled();
    const retry: () => Promise<void> = error.mock.calls[0][1];
    const retried = retry();
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(fakes.invoke).not.toHaveBeenCalled();
    save.resolve();
    await retried;
    expect(fakes.invoke).toHaveBeenCalledExactlyOnceWith("complete_exit");
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls.map(([retry]) => retry)).toEqual([false, true]);
  });
  it.each(["resolve", "reject"] as const)(
    "ignores a pending flush that %ss after listener disposal",
    async (outcome) => {
      const save = deferred();
      const error = vi.fn();
      const unclose = vi.fn();
      const unexit = vi.fn();
      fakes.onClose.mockResolvedValueOnce(unclose);
      fakes.listen.mockResolvedValueOnce(unexit);
      const cleanup = await listenForClose(() => save.promise, error);
      const close = fakes.onClose.mock.calls[0][0];
      close({ preventDefault: vi.fn() });
      cleanup();
      if (outcome === "resolve") save.resolve();
      else save.reject(new Error("late flush error"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unclose).toHaveBeenCalledOnce();
      expect(unexit).toHaveBeenCalledOnce();
      expect(fakes.destroy).not.toHaveBeenCalled();
      expect(fakes.invoke).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      // Even a queued callback from the old subscription cannot close later.
      fakes.listen.mock.calls[0][1]();
      await Promise.resolve();
      expect(fakes.invoke).not.toHaveBeenCalled();
    },
  );
  it("cancels ownership of an in-flight close when exit listener registration fails", async () => {
    const save = deferred();
    const registration = deferred();
    const unclose = vi.fn();
    fakes.onClose.mockResolvedValueOnce(unclose);
    fakes.listen.mockImplementationOnce(async () => {
      await registration.promise;
      return vi.fn();
    });
    const ready = listenForClose(() => save.promise, vi.fn());
    const failure = expect(ready).rejects.toThrow("event bridge failed");
    await vi.waitFor(() => expect(fakes.listen).toHaveBeenCalledOnce());
    fakes.onClose.mock.calls[0][0]({ preventDefault: vi.fn() });
    registration.reject(new Error("event bridge failed"));
    await failure;
    save.resolve();
    await Promise.resolve();
    expect(unclose).toHaveBeenCalledOnce();
    expect(fakes.destroy).not.toHaveBeenCalled();
  });
  it("allows retry when native window destruction itself fails", async () => {
    const failure = new Error("window bridge unavailable");
    fakes.destroy.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const error = vi.fn();
    const flush = vi.fn(async () => {});
    await listenForClose(flush, error);
    fakes.onClose.mock.calls[0][0]({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure, expect.any(Function)));
    await error.mock.calls[0][1]();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(fakes.destroy).toHaveBeenCalledTimes(2);
    expect(fakes.invoke).not.toHaveBeenCalled();
  });
});
describe("hidden-document persistence", () => {
  const setVisibility = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  it("flushes when hidden, reports failures, and stops after disposal", async () => {
    const failure = new Error("position write failed");
    const flush = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const error = vi.fn();
    const dispose = flushWhenHidden(flush, error);
    setVisibility("visible");
    expect(flush).not.toHaveBeenCalled();
    setVisibility("hidden");
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure));
    setVisibility("hidden");
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2));
    expect(error).toHaveBeenCalledOnce();
    dispose();
    setVisibility("hidden");
    expect(flush).toHaveBeenCalledTimes(2);
    setVisibility("visible");
  });
});
describe("Android back button", () => {
  it("runs the first consuming step and otherwise requests the ordered exit", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 15)");
    const unregister = vi.fn();
    fakes.onBack.mockResolvedValue({ unregister });
    fakes.invoke.mockResolvedValue(undefined);
    let layerOpen = true;
    const dismiss = vi.fn(() => layerOpen);
    const home = vi.fn(() => false);
    const dispose = await listenForBack([dismiss, home]);
    const press = fakes.onBack.mock.calls[0][0];
    press({ canGoBack: false });
    expect(home).not.toHaveBeenCalled();
    expect(fakes.invoke).not.toHaveBeenCalled();
    layerOpen = false;
    press({ canGoBack: false });
    expect(home).toHaveBeenCalledOnce();
    expect(fakes.invoke).toHaveBeenCalledWith("request_exit");
    dispose();
    expect(unregister).toHaveBeenCalledOnce();
  });
  it("does not register outside Android", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh)");
    await listenForBack([]);
    expect(fakes.onBack).not.toHaveBeenCalled();
  });
});

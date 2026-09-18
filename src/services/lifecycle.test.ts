import { describe, it, expect, vi, beforeEach } from "vitest";
const fakes = vi.hoisted(() => ({
  onClose: vi.fn(),
  listen: vi.fn(),
  invoke: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: fakes.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: fakes.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: fakes.onClose, destroy: fakes.destroy }),
}));
import { listenForClose } from "./lifecycle";
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
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure));
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
});

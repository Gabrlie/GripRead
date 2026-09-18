import { describe, expect, it, vi } from "vitest";
const invokeMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
import { tauriServices } from "./ipc";
describe("native service boundary", () => {
  it("sends generated request DTOs to the real command names", async () => {
    invokeMock.mockResolvedValueOnce({ text: "正文" });
    const request = { bookId: "b", locator: null, maxUnits: 4096, direction: "backward" as const };
    await tauriServices.reader.readContentWindow(request);
    expect(invokeMock).toHaveBeenCalledWith("read_content_window", { request });
  });
  it("cancelling the native picker creates no import", async () => {
    invokeMock.mockClear();
    openMock.mockResolvedValueOnce(null);
    expect(await tauriServices.library.pickAndImportTxt()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
  it("imports the selected path through Rust", async () => {
    openMock.mockResolvedValueOnce("/books/test.txt");
    invokeMock.mockResolvedValueOnce({ operationId: "op" });
    expect(await tauriServices.library.pickAndImportTxt()).toEqual({ operationId: "op" });
    expect(invokeMock).toHaveBeenLastCalledWith("start_import", {
      request: { path: "/books/test.txt" },
    });
  });
  it("preserves a backend failure without synthetic success", async () => {
    invokeMock.mockRejectedValueOnce({ code: "asset_missing", message: "asset gone" });
    await expect(tauriServices.library.listBooks()).rejects.toMatchObject({
      code: "asset_missing",
      message: "asset_missing: asset gone",
    });
  });
});

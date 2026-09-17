import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { ReaderServiceError, tauriReaderService } from "./ipc";

describe("tauriReaderService", () => {
  it("keeps typed command arguments at the IPC boundary", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await expect(tauriReaderService.listBooks()).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("list_books", undefined);
  });

  it("normalizes structured Rust errors for callers", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "asset_missing",
      message: "managed TXT asset is missing",
    });

    await expect(tauriReaderService.listBooks()).rejects.toEqual(
      expect.objectContaining<Partial<ReaderServiceError>>({
        name: "ReaderServiceError",
        code: "asset_missing",
        message: "asset_missing: managed TXT asset is missing",
      }),
    );
  });

  it("maps unknown IPC failures to the IO error code", async () => {
    invokeMock.mockRejectedValueOnce(new Error("bridge unavailable"));

    await expect(tauriReaderService.listBooks()).rejects.toEqual(
      expect.objectContaining<Partial<ReaderServiceError>>({
        code: "io",
        message: "io: bridge unavailable",
      }),
    );
  });
});

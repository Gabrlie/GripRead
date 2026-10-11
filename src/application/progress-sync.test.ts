import { describe, expect, it, vi } from "vitest";
import { syncServiceMocks } from "../test/sync";
import { ProgressSync } from "./progress-sync";

describe("progress sync ordering", () => {
  it("fetches only after the book's slow upload has finished", async () => {
    const service = syncServiceMocks();
    const order: string[] = [];
    let finishUpload!: () => void;
    vi.mocked(service.uploadProgress).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpload = () => {
            order.push("uploaded");
            resolve(true);
          };
        }),
    );
    vi.mocked(service.fetchProgress).mockImplementation(async () => {
      order.push("fetched");
      return null;
    });
    const sync = new ProgressSync(service);
    void sync.upload("book", "第一章");
    const fetched = sync.fetch("book");
    await vi.waitFor(() => expect(service.uploadProgress).toHaveBeenCalled());
    expect(service.fetchProgress).not.toHaveBeenCalled();
    finishUpload();
    await fetched;
    expect(order).toEqual(["uploaded", "fetched"]);
  });

  it("keeps going after a failed upload", async () => {
    const service = syncServiceMocks();
    vi.mocked(service.uploadProgress).mockRejectedValue(new Error("offline"));
    const sync = new ProgressSync(service);
    await expect(sync.upload("book", "")).rejects.toThrow("offline");
    await expect(sync.fetch("book")).resolves.toBeNull();
  });
});

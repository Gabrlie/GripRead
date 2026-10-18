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

  it("does not bring back a version answered while fetches were queued", async () => {
    const service = syncServiceMocks();
    const prompt = {
      deviceId: "other",
      deviceName: "",
      revision: 3,
      writtenAt: 1,
      chapterTitle: "",
      excerpt: "",
      locator: {
        bookId: "book",
        contentVersion: "v",
        resourceId: "r",
        offset: 4,
        contextBefore: "",
        contextAfter: "",
      },
    };
    vi.mocked(service.fetchProgress).mockResolvedValue(prompt);
    const sync = new ProgressSync(service);
    const first = sync.fetch("book");
    expect(await first).toEqual(prompt);
    const queued = sync.fetch("book");
    // Waiting to start: shared.
    expect(sync.fetch("book")).toBe(queued);
    await sync.acknowledge(prompt, "book");
    expect(await queued).toBeNull();
    expect(service.acknowledgeProgress).toHaveBeenCalledWith("book", "other", 3, prompt.locator);
    // A newer version is asked about.
    vi.mocked(service.fetchProgress).mockResolvedValue({ ...prompt, revision: 4 });
    expect((await sync.fetch("book"))?.revision).toBe(4);
  });
});

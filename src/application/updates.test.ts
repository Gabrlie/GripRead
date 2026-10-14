import { describe, expect, it, vi } from "vitest";
import { noUpdate, updateServiceMocks, updateSettings } from "../test/updates";
import type { UpdateProgress } from "../types/generated";
import { AUTO_CHECK_EVERY_MS, autoCheckDue, installUpdate, promptFor, sizeLabel } from "./updates";

const update = {
  version: "0.2.2",
  prerelease: false,
  publishedAt: 0,
  notes: "",
  url: "",
  asset: "gripread-0.2.2-arm64-v8a.apk",
  size: 1,
};

describe("updates", () => {
  it("checks automatically at most once a day", () => {
    const now = 10 * AUTO_CHECK_EVERY_MS;
    expect(autoCheckDue(updateSettings(), now)).toBe(true);
    expect(autoCheckDue(updateSettings({ lastCheck: now - 1000 }), now)).toBe(false);
    expect(autoCheckDue(updateSettings({ lastCheck: now - AUTO_CHECK_EVERY_MS }), now)).toBe(true);
    expect(autoCheckDue(updateSettings({ autoCheck: false }), now)).toBe(false);
  });

  it("prompts for newer versions that were not skipped, except on the web", () => {
    const check = { ...noUpdate(), update };
    expect(promptFor(check, updateSettings())).toBe(update);
    expect(promptFor(check, updateSettings({ skipped: "0.2.2" }))).toBeNull();
    expect(promptFor({ ...check, kind: "server" }, updateSettings())).toBeNull();
    expect(promptFor(noUpdate(), updateSettings())).toBeNull();
  });

  it("labels sizes", () => {
    expect(sizeLabel(41_350_878)).toBe("39.4 MB");
    expect(sizeLabel(10)).toBe("1 KB");
  });

  it("reports this install's progress only and cancels its operation", async () => {
    let emit: (progress: UpdateProgress) => void = () => undefined;
    let finish: () => void = () => undefined;
    const unsubscribe = vi.fn();
    const service = updateServiceMocks({
      onProgress: vi.fn(async (listener) => {
        emit = listener;
        return unsubscribe;
      }),
      install: vi.fn(
        (operationId: string) =>
          new Promise<"started">((resolve) => {
            emit({ operationId: "other", received: 1, total: 9 });
            emit({ operationId, received: 5, total: 10 });
            finish = () => resolve("started");
          }),
      ),
    });
    const seen = vi.fn();
    const controller = new AbortController();
    const done = installUpdate(service, "0.2.2", seen, controller.signal);
    await vi.waitFor(() => expect(service.install).toHaveBeenCalled());
    controller.abort();
    finish();
    expect(await done).toBe("started");
    expect(seen).toHaveBeenCalledExactlyOnceWith({ received: 5, total: 10 });
    const operationId = vi.mocked(service.install).mock.calls[0]![0];
    expect(service.cancel).toHaveBeenCalledWith(operationId);
    expect(unsubscribe).toHaveBeenCalled();
  });
});

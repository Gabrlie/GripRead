// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices, UpdateService } from "../../services/contracts";
import { noUpdate, updateServiceMocks } from "../../test/updates";
import { APP_VERSION, AboutPage } from "./AboutPage";

afterEach(cleanup);

function page(updates: UpdateService) {
  const runtime = new AppRuntime({
    library: { listBooks: vi.fn(async () => []), onImportProgress: vi.fn(async () => () => {}) },
    reader: {},
    settings: {},
    sync: {},
    sources: {},
    updates,
  } as unknown as AppServices);
  render(
    <RuntimeContext.Provider value={runtime}>
      <AboutPage onClose={() => undefined} />
    </RuntimeContext.Provider>,
  );
}

const release = {
  version: "9.9.9",
  prerelease: true,
  publishedAt: Date.UTC(2026, 9, 14),
  notes: "## 更新内容\n\n- **reader：** 新功能 ([abc1234](https://x))",
  url: "",
};

describe("关于", () => {
  it("checks on opening, shows the notes, and installs the update", async () => {
    const updates = updateServiceMocks({
      check: vi.fn(async (current: string) => ({
        ...noUpdate(current),
        update: { ...release, asset: "gripread-9.9.9-arm64-v8a.apk", size: 2_097_152 },
        releases: [release],
        viaServer: true,
      })),
    });
    page(updates);
    expect(await screen.findByText("发现新版本 9.9.9")).toBeTruthy();
    expect(updates.check).toHaveBeenCalledWith(APP_VERSION);
    expect(screen.getByText(/经由服务器/)).toBeTruthy();
    expect(screen.getAllByText(/新功能/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/abc1234\]/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /立即更新（2.0 MB）/ }));
    expect(updates.install).toHaveBeenCalledWith(expect.stringMatching(/^update-/), "9.9.9");
    expect(await screen.findByText(/已打开系统安装程序/)).toBeTruthy();
  });

  it("asks for the install permission, switches channels, and turns off automatic checks", async () => {
    const updates = updateServiceMocks({
      check: vi.fn(async (current: string) => ({
        ...noUpdate(current),
        update: { ...release, asset: "gripread-9.9.9-universal.apk", size: 1 },
      })),
      install: vi.fn(async () => "needsPermission" as const),
    });
    page(updates);
    await userEvent.click(await screen.findByRole("button", { name: /立即更新/ }));
    expect(await screen.findByText(/安装未知应用/)).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "测试版" }));
    expect(updates.saveSettings).toHaveBeenCalledWith({
      channel: "beta",
      autoCheck: true,
      skipped: null,
    });
    await vi.waitFor(() => expect(updates.check).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("switch", { name: /自动检查更新/ }));
    expect(updates.saveSettings).toHaveBeenLastCalledWith({
      channel: "beta",
      autoCheck: false,
      skipped: null,
    });
  });

  it("tells the web version to pull the server image", async () => {
    page(
      updateServiceMocks({
        check: vi.fn(async (current: string) => ({
          ...noUpdate(current),
          kind: "server" as const,
          update: { ...release, asset: null, size: null },
        })),
      }),
    );
    expect(await screen.findByText(/docker pull ghcr.io\/gabrlie\/gripread:9.9.9/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /立即更新/ })).toBeNull();
  });
});

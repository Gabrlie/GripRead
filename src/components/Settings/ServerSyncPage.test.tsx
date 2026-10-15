// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { disconnectedServer, syncServiceMocks, unconfiguredWebDav } from "../../test/sync";
import { ServerSyncPage } from "./ServerSyncPage";

afterEach(cleanup);

function page(change?: (sync: ReturnType<typeof syncServiceMocks>) => void) {
  const sync = syncServiceMocks();
  change?.(sync);
  const runtime = new AppRuntime({
    library: { listBooks: vi.fn(async () => []), onImportProgress: vi.fn(async () => () => {}) },
    reader: {},
    settings: {},
    sync,
    sources: {},
  } as unknown as AppServices);
  render(
    <RuntimeContext.Provider value={runtime}>
      <ServerSyncPage onClose={() => undefined} />
    </RuntimeContext.Provider>,
  );
  return sync;
}

describe("服务器", () => {
  it("connects with the server's password, then offers sync and disconnecting", async () => {
    const sync = page();
    await userEvent.type(await screen.findByLabelText("服务器地址"), "reader.example.com");
    await userEvent.type(screen.getByLabelText("密码"), "secret1");
    await userEvent.type(screen.getByLabelText("设备名"), "手机");
    await userEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(sync.connectServer).toHaveBeenCalledWith({
      address: "reader.example.com",
      password: "secret1",
      deviceName: "手机",
    });
    expect(await screen.findByText("reader.example.com")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "立即同步" }));
    expect(sync.syncServerNow).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("switch", { name: /自动下载/ }));
    expect(sync.setServerAutoDownload).toHaveBeenCalledWith(false);
    await userEvent.click(screen.getByRole("switch", { name: /通过服务器更新书籍/ }));
    expect(sync.setServerUpdateViaServer).toHaveBeenCalledWith(false);
    // 同步内容 is 同步排除 the other way round.
    sync.saveWebDav = vi.fn(async (request) => ({
      ...unconfiguredWebDav(),
      restoreIgnore: request.restoreIgnore,
    }));
    const sources = await screen.findByRole("switch", { name: /^书源/ });
    expect(sources.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sources);
    expect(sync.saveWebDav).toHaveBeenCalledWith(
      expect.objectContaining({ restoreIgnore: ["sources"] }),
    );
    await waitFor(() => expect(sources.getAttribute("aria-checked")).toBe("false"));
    await userEvent.click(screen.getByRole("button", { name: "断开" }));
    expect(sync.disconnectServer).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "连接" })).toBeTruthy();
  });

  it("connects again with the kept sign-in, or forgets it", async () => {
    const remembered = (sync: ReturnType<typeof syncServiceMocks>) => {
      sync.getServer = vi.fn(async () => ({
        ...disconnectedServer(),
        remembered: true,
        address: "https://reader.example.com",
        deviceName: "手机",
      }));
    };
    const sync = page(remembered);
    expect(((await screen.findByLabelText("服务器地址")) as HTMLInputElement).value).toBe(
      "https://reader.example.com",
    );
    expect(screen.getByPlaceholderText("使用保存的密码")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(sync.connectServer).toHaveBeenCalledWith({
      address: "https://reader.example.com",
      password: "",
      deviceName: "手机",
    });
    cleanup();

    const again = page(remembered);
    await userEvent.click(await screen.findByRole("button", { name: "忘记登录信息" }));
    expect(again.forgetServerLogin).toHaveBeenCalled();
    expect((screen.getByLabelText("服务器地址") as HTMLInputElement).value).toBe("");
  });
});

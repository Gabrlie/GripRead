// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { syncServiceMocks } from "../../test/sync";
import { ServerSyncPage } from "./ServerSyncPage";

afterEach(cleanup);

function page() {
  const sync = syncServiceMocks();
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

describe("服务器同步", () => {
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
    await userEvent.click(screen.getByRole("button", { name: "断开" }));
    expect(sync.disconnectServer).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "连接" })).toBeTruthy();
  });
});

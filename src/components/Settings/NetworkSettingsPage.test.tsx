// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { PREVIEW_NETWORK } from "../../preview/network";
import { NetworkSettingsPage } from "./NetworkSettingsPage";

afterEach(cleanup);

describe("网络设置", () => {
  it("tests DoH, sets a proxy and custom limits, and saves", async () => {
    const settings = {
      getNetwork: vi.fn(async () => PREVIEW_NETWORK),
      saveNetwork: vi.fn(async (value) => value),
      checkNetwork: vi.fn(async () => ({ millis: 40, detail: "www.baidu.com → 1.2.3.4" })),
    };
    const runtime = new AppRuntime({
      library: {
        listBooks: vi.fn(async () => []),
        onImportProgress: vi.fn(async () => () => undefined),
      },
      reader: {},
      settings,
      sync: {},
      sources: {},
    } as unknown as AppServices);
    render(
      <RuntimeContext.Provider value={runtime}>
        <NetworkSettingsPage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    const save = await screen.findByRole("button", { name: "保存" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "测试 DoH" }));
    await vi.waitFor(() =>
      expect(settings.checkNetwork).toHaveBeenCalledWith(PREVIEW_NETWORK, "doh"),
    );
    await userEvent.click(screen.getByRole("radio", { name: "SOCKS5" }));
    await userEvent.type(screen.getByRole("textbox", { name: "代理地址" }), "10.0.0.2");
    await userEvent.click(screen.getAllByRole("radio", { name: "自定义" }).at(-1)!);
    const requests = screen.getByRole("textbox", { name: "同时请求数" });
    await userEvent.clear(requests);
    await userEvent.type(requests, "20");
    await userEvent.click(save);
    await vi.waitFor(() =>
      expect(settings.saveNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          proxyKind: "socks5",
          proxyHost: "10.0.0.2",
          preset: "custom",
          custom: expect.objectContaining({ requests: 20 }),
        }),
      ),
    );
  });
});

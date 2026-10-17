// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { PREVIEW_NETWORK } from "../../preview/network";
import { NetworkSettingsPage, badBootstrap } from "./NetworkSettingsPage";

afterEach(cleanup);

describe("网络设置", () => {
  it("tests DoH, and saves a proxy and custom limits by itself", async () => {
    const settings = {
      getNetwork: vi.fn(async () => PREVIEW_NETWORK),
      saveNetwork: vi.fn(async (value) => value),
      checkNetwork: vi.fn(async () => ({ millis: 40, detail: "www.baidu.com → 1.2.3.4" })),
      networkState: vi.fn(async () => ({ systemProxy: "127.0.0.1:8080" })),
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
    const view = render(
      <RuntimeContext.Provider value={runtime}>
        <NetworkSettingsPage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    await userEvent.click(await screen.findByRole("switch", { name: /使用 DoH/ }));
    expect(await screen.findByText("检测到系统代理 127.0.0.1:8080，DoH 不生效")).toBeTruthy();
    await vi.waitFor(() =>
      expect(settings.saveNetwork).toHaveBeenCalledWith(
        expect.objectContaining({ dohEnabled: true }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "测试 DoH" }));
    await vi.waitFor(() =>
      expect(settings.checkNetwork).toHaveBeenCalledWith(
        expect.objectContaining({ dohEnabled: true }),
        "doh",
      ),
    );
    await userEvent.click(screen.getByRole("radio", { name: "SOCKS5" }));
    await userEvent.type(screen.getByRole("textbox", { name: "代理地址" }), "10.0.0.2");
    await userEvent.click(screen.getAllByRole("radio", { name: "自定义" }).at(-1)!);
    const requests = screen.getByRole("textbox", { name: "同时请求数" });
    await userEvent.clear(requests);
    await userEvent.type(requests, "20");
    expect(screen.getByText("使用代理时 DoH 不生效")).toBeTruthy();
    // Leaving right away still saves the last change.
    view.unmount();
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

  it("names the 引导 IP entries that are not addresses", () => {
    expect(badBootstrap("1.1.1.1, [2606:4700::1111]，8.8.8.8")).toEqual([]);
    expect(badBootstrap("1.1.1.1 doh.example 300.1.1.1")).toEqual(["doh.example", "300.1.1.1"]);
  });
});

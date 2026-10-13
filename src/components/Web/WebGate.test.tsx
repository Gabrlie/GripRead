// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { WebGate } from "./WebGate";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function server(status: { configured: boolean; signedIn: boolean }) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/status") return Response.json(status);
    const { password } = JSON.parse(String(init?.body)) as { password: string };
    if (password === "secret1") return Response.json({ token: "t" });
    return Response.json({ code: "unauthorized", message: "密码不对" }, { status: 401 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("web sign-in", () => {
  it("sets the password on the first run, then shows the app", async () => {
    const fetch = server({ configured: false, signedIn: false });
    render(<WebGate>书架</WebGate>);
    await userEvent.type(await screen.findByLabelText("密码"), "secret1");
    await userEvent.type(screen.getByLabelText("确认密码"), "secret2");
    await userEvent.click(screen.getByRole("button", { name: "设置密码" }));
    expect(screen.getByRole("alert").textContent).toBe("两次输入的密码不一样");
    await userEvent.clear(screen.getByLabelText("确认密码"));
    await userEvent.type(screen.getByLabelText("确认密码"), "secret1");
    await userEvent.click(screen.getByRole("button", { name: "设置密码" }));
    expect(await screen.findByText("书架")).toBeTruthy();
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/auth/setup",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("signs in, telling a wrong password apart", async () => {
    server({ configured: true, signedIn: false });
    render(<WebGate>书架</WebGate>);
    const password = await screen.findByLabelText("密码");
    expect(screen.queryByLabelText("确认密码")).toBeNull();
    await userEvent.type(password, "wrong");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect((await screen.findByRole("alert")).textContent).toBe("密码不对");
    await userEvent.clear(password);
    await userEvent.type(password, "secret1");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("书架")).toBeTruthy();
  });

  it("shows the app at once for a signed-in page", async () => {
    server({ configured: true, signedIn: true });
    render(<WebGate>书架</WebGate>);
    expect(await screen.findByText("书架")).toBeTruthy();
  });
});

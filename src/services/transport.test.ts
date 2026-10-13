// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { call, listen, onSignedOut } from "./transport";

class FakeSocket {
  static opened: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.opened.push(this);
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("web transport", () => {
  it("posts commands to the server and reads JSON, bytes, and failures", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/list_groups"))
        return new Response(JSON.stringify([{ id: "g" }]), {
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/online_cover"))
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/octet-stream" },
        });
      if (url.endsWith("/list_books"))
        return new Response(JSON.stringify({ code: "unauthorized", message: "请先登录" }), {
          status: 401,
        });
      return new Response(
        JSON.stringify({ code: "invalid_argument", message: String(init?.body) }),
        {
          status: 400,
        },
      );
    });
    vi.stubGlobal("fetch", fetch);
    expect(await call("list_groups")).toEqual([{ id: "g" }]);
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/rpc/list_groups",
      expect.objectContaining({ method: "POST", body: undefined }),
    );
    const cover = await call<ArrayBuffer>("online_cover", { request: { url: "x" } });
    expect(Array.from(new Uint8Array(cover))).toEqual([1, 2, 3]);
    await expect(call("create_group", { request: { name: "a" } })).rejects.toEqual({
      code: "invalid_argument",
      message: '{"request":{"name":"a"}}',
    });
    const signedOut = vi.fn();
    onSignedOut(signedOut);
    await expect(call("list_books")).rejects.toMatchObject({ code: "unauthorized" });
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it("shares one event socket among listeners", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const progress = vi.fn();
    const other = vi.fn();
    const stopProgress = await listen("import-progress", progress);
    const stopOther = await listen("download-progress", other);
    expect(FakeSocket.opened).toHaveLength(1);
    const socket = FakeSocket.opened[0];
    expect(socket.url).toMatch(/^ws:\/\/.*\/api\/events$/);
    socket.onmessage?.({
      data: JSON.stringify({ event: "import-progress", payload: { phase: "reading" } }),
    });
    socket.onmessage?.({ data: "not json" });
    expect(progress).toHaveBeenCalledWith({ phase: "reading" });
    expect(other).not.toHaveBeenCalled();
    stopProgress();
    expect(socket.closed).toBe(false);
    stopOther();
    expect(socket.closed).toBe(true);
  });
});

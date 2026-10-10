import { describe, expect, it, vi } from "vitest";
const invokeMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
import { tauriServices } from "./ipc";
describe("native service boundary", () => {
  it("sends generated request DTOs to the real command names", async () => {
    invokeMock.mockResolvedValueOnce({ text: "正文" });
    const request = { bookId: "b", locator: null, maxUnits: 4096, direction: "backward" as const };
    await tauriServices.reader.readContentWindow(request);
    expect(invokeMock).toHaveBeenCalledWith("read_content_window", { request });
  });
  it("cancelling the native picker creates no import", async () => {
    invokeMock.mockClear();
    openMock.mockResolvedValueOnce(null);
    expect(await tauriServices.library.pickAndImportTxt()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
  it("imports the selected path through Rust", async () => {
    openMock.mockResolvedValueOnce("/books/test.txt");
    invokeMock.mockResolvedValueOnce({ operationId: "op" });
    expect(await tauriServices.library.pickAndImportTxt()).toEqual({ operationId: "op" });
    expect(invokeMock).toHaveBeenLastCalledWith("start_import", {
      request: { path: "/books/test.txt" },
    });
  });
  it("preserves a backend failure without synthetic success", async () => {
    invokeMock.mockRejectedValueOnce({ code: "asset_missing", message: "asset gone" });
    await expect(tauriServices.library.listBooks()).rejects.toMatchObject({
      code: "asset_missing",
      message: "asset_missing: asset gone",
    });
  });
  it("persists group operations through their typed library commands", async () => {
    invokeMock.mockReset();
    const group = { id: "group", name: "自定义", bookIds: ["book"] };
    invokeMock.mockResolvedValueOnce([group]);
    expect(await tauriServices.library.listGroups()).toEqual([group]);
    expect(invokeMock).toHaveBeenLastCalledWith("list_groups", undefined);
    invokeMock.mockResolvedValueOnce(group);
    expect(await tauriServices.library.createGroup("自定义")).toEqual(group);
    expect(invokeMock).toHaveBeenLastCalledWith("create_group", { request: { name: "自定义" } });
    invokeMock.mockResolvedValueOnce({ ...group, name: "已重命名" });
    expect(await tauriServices.library.renameGroup("group", "已重命名")).toMatchObject({
      name: "已重命名",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("rename_group", {
      request: { id: "group", name: "已重命名" },
    });
    invokeMock.mockResolvedValueOnce(undefined);
    await tauriServices.library.moveBook("book", { kind: "group", value: "group" });
    expect(invokeMock).toHaveBeenLastCalledWith("move_book", {
      request: { bookId: "book", placement: { kind: "group", value: "group" } },
    });
    invokeMock.mockResolvedValueOnce(undefined);
    await tauriServices.library.deleteGroup("group");
    expect(invokeMock).toHaveBeenLastCalledWith("delete_group", { request: { id: "group" } });
  });
  it("reports rejected group membership changes instead of pretending they persisted", async () => {
    invokeMock.mockRejectedValueOnce({ code: "not_found", message: "library group was not found" });
    await expect(
      tauriServices.library.moveBook("book", { kind: "group", value: "absent" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

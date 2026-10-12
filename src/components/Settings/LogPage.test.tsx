// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { appLog } from "../../services/log";
import { LogPage } from "./LogPage";

afterEach(cleanup);

describe("日志", () => {
  it("lists entries by level and clears them", async () => {
    await appLog.clear();
    appLog.write("error", "source", "甲站 搜索失败：网站返回 403");
    appLog.write("info", "sync", "已备份到 WebDAV");
    render(<LogPage onClose={() => undefined} />);
    const list = await screen.findByRole("list", { name: "日志" });
    expect(within(list).getByText("甲站 搜索失败：网站返回 403")).toBeTruthy();
    expect(within(list).getByText("已备份到 WebDAV")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "错误" }));
    await screen.findByText("甲站 搜索失败：网站返回 403");
    expect(screen.queryByText("已备份到 WebDAV")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(await screen.findByText("没有日志。")).toBeTruthy();
  });
});

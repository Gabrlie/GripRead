// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { sourceServiceMocks } from "../../test/sources";
import { SourceManagePage } from "./SourceManagePage";
import { SourceEditPage } from "./SourceEditPage";

afterEach(cleanup);

const SOURCES = [
  {
    bookSourceUrl: "https://a.com",
    bookSourceName: "甲站",
    bookSourceGroup: "常用",
    searchUrl: "/s?q={{key}}",
    customOrder: 0,
  },
  {
    bookSourceUrl: "https://b.com",
    bookSourceName: "乙站",
    exploreUrl: "榜::/r",
    customOrder: 1,
    enabled: false,
  },
];

describe("书源管理", () => {
  it("imports pasted sources after a preview of what changes", async () => {
    const service = sourceServiceMocks(SOURCES);
    render(<SourceManagePage service={service} onClose={() => undefined} />);
    await screen.findByText("甲站");
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "粘贴导入" }));
    fireEvent.change(screen.getByRole("textbox", { name: "书源 JSON" }), {
      target: {
        value: JSON.stringify([
          { bookSourceUrl: "https://c.com", bookSourceName: "丙站" },
          { bookSourceUrl: "https://a.com", bookSourceName: "甲站", lastUpdateTime: 0 },
          { bookSourceUrl: "https://audio.com", bookSourceName: "音", bookSourceType: 1 },
        ]),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "下一步" }));
    const list = await screen.findByRole("list", { name: "待导入的书源" });
    expect(within(list).getByText("新增")).toBeTruthy();
    expect(within(list).getByText("已有")).toBeTruthy();
    expect(screen.getByText(/跳过 1 个音频/)).toBeTruthy();
    expect(service.importSources).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "导入 1 个" }));
    expect(await screen.findByText("丙站")).toBeTruthy();
    expect(service.importSources).toHaveBeenCalledWith(
      expect.objectContaining({ urls: ["https://c.com"], keepName: true }),
    );
  });

  it("filters, switches, and acts on a selection", async () => {
    const service = sourceServiceMocks(SOURCES);
    render(<SourceManagePage service={service} onClose={() => undefined} />);
    await screen.findByText("甲站");
    await userEvent.click(screen.getByRole("button", { name: "已禁用" }));
    expect(screen.queryByText("甲站")).toBeNull();
    expect(screen.getByText("乙站")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "启用 乙站" }));
    expect(service.setSwitch).toHaveBeenCalledWith(["https://b.com"], "enabled", true);
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "多选" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "选择 甲站" }));
    const actions = screen.getByLabelText("批量操作");
    await userEvent.click(within(actions).getByRole("button", { name: "删除" }));
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "删除书源" })).getByRole("button", {
        name: "删除",
      }),
    );
    await waitFor(() => expect(screen.queryByText("甲站")).toBeNull());
    expect(service.deleteSources).toHaveBeenCalledWith(["https://a.com"]);
  });

  it("checks sources and reports progress until done", async () => {
    const service = sourceServiceMocks(SOURCES);
    render(<SourceManagePage service={service} onClose={() => undefined} />);
    await screen.findByText("甲站");
    await userEvent.click(screen.getByRole("button", { name: "甲站 的更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "校验" }));
    await userEvent.click(screen.getByRole("button", { name: "开始校验" }));
    expect(service.check).toHaveBeenCalledWith(
      expect.objectContaining({ urls: ["https://a.com"], keyword: "", disableFailed: true }),
    );
    expect(await screen.findByText("校验完成 1/1")).toBeTruthy();
  });
});

describe("书源编辑", () => {
  it("edits fields by tab, keeps the JSON in step, and warns before discarding", async () => {
    const service = sourceServiceMocks(SOURCES);
    let closed = false;
    render(
      <SourceEditPage
        service={service}
        url="https://a.com"
        onSaved={() => undefined}
        onDebug={() => undefined}
        onLogin={() => undefined}
        onClose={() => {
          closed = true;
        }}
      />,
    );
    const name = await screen.findByRole("textbox", { name: "书源名称" });
    fireEvent.change(name, { target: { value: "甲站改" } });
    await userEvent.click(screen.getByRole("tab", { name: "目录" }));
    fireEvent.change(screen.getByRole("textbox", { name: "目录列表规则" }), {
      target: { value: "id.list@dd" },
    });
    await userEvent.click(screen.getByRole("tab", { name: "JSON" }));
    const json = (screen.getByRole("textbox", { name: "书源 JSON" }) as HTMLTextAreaElement).value;
    expect(JSON.parse(json)).toMatchObject({
      bookSourceName: "甲站改",
      ruleToc: { chapterList: "id.list@dd" },
    });
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(await screen.findByText("书源有未保存的修改。")).toBeTruthy();
    expect(closed).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(closed).toBe(true));
    const saved = await service.getSource("https://a.com");
    expect(JSON.parse(saved.json)).toMatchObject({ bookSourceName: "甲站改" });
  });
});

// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type { ReaderPreferences } from "../../types/generated";
import { DEFAULT_READING_STYLE } from "../../types/generated";
import { TocRulesPage } from "./TocRulesPage";

afterEach(cleanup);

function runtime() {
  const saveSettings = vi.fn(async (value: ReaderPreferences) => value);
  const services = {
    library: { listBooks: vi.fn(async () => []), onImportProgress: vi.fn(async () => () => {}) },
    reader: {
      listTxtTocRules: vi.fn(async () => [
        {
          id: "legado-8",
          name: "数字 分隔符 标题名称",
          pattern: "^\\d+、.*$",
          example: "",
          serial: 0,
          enabled: true,
          builtin: true,
          loose: true,
        },
      ]),
      exportTxtTocRules: vi.fn(async () => "[]"),
    },
    settings: {
      getSettings: vi.fn(async (): Promise<ReaderPreferences> => ({
        theme: "system",
        paperTone: "warm-tea",
        oledBlack: false,
        fontSize: 18,
        lineHeight: 1.8,
        fontFamily: "serif",
        pageTurnEffect: "curl",
        autoPageSeconds: 8,
        readingMode: "single",
        autoScrollSpeed: 40,
        customStyles: [],
        pinnedStyles: [],
        style: DEFAULT_READING_STYLE,
      })),
      saveSettings,
    },
    sync: {},
    sources: {},
  } as unknown as AppServices;
  return { app: new AppRuntime(services), saveSettings };
}

describe("目录规则 page", () => {
  it("sets the default titles of books no rule splits, and keeps import and export in More", async () => {
    const { app, saveSettings } = runtime();
    await act(async () => {
      await app.settings.load();
    });
    render(
      <RuntimeContext.Provider value={app}>
        <TocRulesPage service={app.services.reader} onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    expect(await screen.findByText("宽松")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(await screen.findByRole("menuitem", { name: "导入" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "导出" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /未命中规则时的默认标题/ }));
    await userEvent.click(await screen.findByRole("radio", { name: "第 1 节" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ tocUntitledTitle: "第{n}节", tocChunkKb: undefined }),
      ),
    );
    expect(await screen.findByText("第 1 节")).toBeTruthy();
  });
});

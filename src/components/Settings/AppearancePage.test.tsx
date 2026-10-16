// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type { ReaderPreferences } from "../../types/generated";
import { AppearancePage } from "./AppearancePage";

afterEach(cleanup);

describe("更多外观设置", () => {
  it("makes a style from a main colour, uses it, and keeps 外观 to four", async () => {
    const preferences = {
      theme: "light",
      paperTone: "warm-tea",
      oledBlack: false,
      customStyles: [],
      pinnedStyles: [],
    } as unknown as ReaderPreferences;
    const runtime = new AppRuntime({
      library: { listBooks: vi.fn(async () => []), onImportProgress: vi.fn(async () => () => {}) },
      reader: {},
      settings: {
        getSettings: vi.fn(async () => preferences),
        saveSettings: vi.fn(async (value: ReaderPreferences) => value),
      },
      sync: {},
      sources: {},
    } as unknown as AppServices);
    await runtime.settings.load();
    render(
      <RuntimeContext.Provider value={runtime}>
        <AppearancePage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /新建样式/ }));
    const name = screen.getByLabelText("名称");
    await userEvent.clear(name);
    await userEvent.type(name, "海");
    // The page colour is left to 自动 and shown as derived.
    expect((screen.getByLabelText("页面颜色 #") as HTMLInputElement).value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = runtime.settings.getSnapshot().value!;
      expect(saved.customStyles).toHaveLength(1);
      expect(saved.customStyles[0]).toMatchObject({ name: "海", primary: "#4a6fa5", paper: null });
      expect(saved.customStyle).toBe(saved.customStyles[0].id);
    });
    // The four tones already fill 外观, so pinning the new one asks to unpin first.
    await userEvent.click(screen.getByRole("button", { name: "固定 海" }));
    expect(runtime.settings.getSnapshot().value!.pinnedStyles).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "固定 羊脂白" }));
    await userEvent.click(screen.getByRole("button", { name: "固定 海" }));
    expect(runtime.settings.getSnapshot().value!.pinnedStyles).toEqual([
      "warm-tea",
      "xuan-paper",
      "jade-green",
      runtime.settings.getSnapshot().value!.customStyles[0].id,
    ]);
  });
});

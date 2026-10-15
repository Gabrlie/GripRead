// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { translationServiceMocks, translationSettings } from "../../test/translation";
import { TranslationDialog } from "../Reader/dialogs/TranslationDialog";
import { TranslationSettingsPage } from "./TranslationSettingsPage";

afterEach(cleanup);

function runtime(translation = translationServiceMocks()) {
  return new AppRuntime({
    library: { listBooks: vi.fn(async () => []), onImportProgress: vi.fn(async () => () => {}) },
    reader: {},
    settings: {},
    sync: {},
    sources: {},
    translation,
  } as unknown as AppServices);
}

describe("翻译", () => {
  it("adds an engine from a preset, tests it, and saves the settings", async () => {
    const translation = translationServiceMocks();
    render(
      <RuntimeContext.Provider value={runtime(translation)}>
        <TranslationSettingsPage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    await userEvent.click(await screen.findByText("添加引擎"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "DeepSeek" }));
    expect((screen.getByLabelText("接口地址") as HTMLInputElement).value).toBe(
      "https://api.deepseek.com/v1",
    );
    await userEvent.type(screen.getByLabelText("API 密钥"), "sk-test");
    await userEvent.click(screen.getByRole("button", { name: "测试" }));
    expect(await screen.findByText("测试译文：测试译文")).toBeTruthy();
    expect(translation.testEngine).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-test", model: "deepseek-chat" }),
      "zh-CN",
    );
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(translation.saveSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          engines: [expect.objectContaining({ name: "DeepSeek", apiKey: "sk-test" })],
        }),
      ),
    );
    await userEvent.click(screen.getByRole("radio", { name: "双语对照" }));
    expect(translation.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ display: "bilingual" }),
    );
  });

  it("turns a book's translation on from the reader and reopens it", async () => {
    const translation = translationServiceMocks({
      getSettings: vi.fn(async () =>
        translationSettings({
          engines: [
            {
              id: "e",
              name: "DeepSeek",
              kind: "openAi",
              baseUrl: "",
              model: "deepseek-chat",
              apiKey: "k",
              prompt: "",
            },
          ],
        }),
      ),
      getBook: vi.fn(async (bookId: string) => ({ bookId, language: "en", translateTo: null })),
    });
    const onChanged = vi.fn();
    render(
      <RuntimeContext.Provider value={runtime(translation)}>
        <TranslationDialog
          bookId="b"
          online
          onChanged={onChanged}
          onOpenSettings={() => undefined}
          onClose={() => undefined}
        />
      </RuntimeContext.Provider>,
    );
    expect(((await screen.findByLabelText("原文语言")) as HTMLSelectElement).value).toBe("en");
    await userEvent.click(screen.getByRole("switch", { name: /翻译成简体中文/ }));
    expect(translation.setBook).toHaveBeenCalledWith("b", "zh-CN");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("asks for an engine before translating", async () => {
    render(
      <RuntimeContext.Provider value={runtime()}>
        <TranslationDialog
          bookId="b"
          online
          onChanged={() => undefined}
          onOpenSettings={() => undefined}
          onClose={() => undefined}
        />
      </RuntimeContext.Provider>,
    );
    expect(await screen.findByText(/先在 设置 › 翻译 中添加翻译引擎/)).toBeTruthy();
  });
});

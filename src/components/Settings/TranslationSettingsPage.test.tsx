// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import type { BookTranslationEvent } from "../../types/generated";
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

  it("translates a local book in the background and shows how far it got", async () => {
    let listener: ((event: BookTranslationEvent) => void) | undefined;
    const translation = translationServiceMocks({
      getSettings: vi.fn(async () =>
        translationSettings({
          engines: [
            {
              id: "e",
              name: "DeepL",
              kind: "deepl",
              baseUrl: "",
              model: "",
              apiKey: "k",
              prompt: "",
            },
          ],
        }),
      ),
      getBook: vi.fn(async (bookId: string) => ({ bookId, language: "en", translateTo: null })),
      onBookProgress: vi.fn(async (next) => {
        listener = next;
        return () => undefined;
      }),
    });
    const onChanged = vi.fn();
    render(
      <RuntimeContext.Provider value={runtime(translation)}>
        <TranslationDialog
          bookId="b"
          online={false}
          onChanged={onChanged}
          onOpenSettings={() => undefined}
          onClose={() => undefined}
        />
      </RuntimeContext.Provider>,
    );
    await userEvent.click(await screen.findByRole("switch", { name: /翻译成简体中文/ }));
    await waitFor(() => expect(translation.translateBook).toHaveBeenCalledWith("b", false));
    expect(onChanged).toHaveBeenCalled();
    act(() =>
      listener?.({
        bookId: "b",
        done: 100,
        total: 300,
        applied: false,
        finished: false,
        error: null,
      }),
    );
    expect(await screen.findByText("已翻译 100/300 段")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(translation.stopBook).toHaveBeenCalledWith("b");
    act(() =>
      listener?.({
        bookId: "b",
        done: 100,
        total: 300,
        applied: true,
        finished: true,
        error: { code: "io", message: "x", key: "engineCount", params: {} },
      }),
    );
    expect(await screen.findByText("翻译中断：翻译结果的行数不对。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "翻译整本" }));
    expect(translation.translateBook).toHaveBeenLastCalledWith("b", true);
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

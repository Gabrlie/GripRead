// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { translationServiceMocks } from "../../test/translation";
import { useIntroTranslation } from "./use-title-translation";

function wrapperWith(language: string) {
  const translation = translationServiceMocks({
    detectLanguages: vi.fn(async (texts: string[]) => texts.map(() => language)),
  });
  const runtime = new AppRuntime({
    library: { listBooks: vi.fn(async () => []), onImportProgress: vi.fn(async () => () => {}) },
    reader: {},
    settings: {},
    sync: {},
    sources: {},
    translation,
  } as unknown as AppServices);
  return ({ children }: { children: ReactNode }) => (
    <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
  );
}

describe("翻译简介", () => {
  it("is offered for an introduction in another language only", async () => {
    const foreign = renderHook(() => useIntroTranslation("The night was quiet."), {
      wrapper: wrapperWith("en"),
    });
    await waitFor(() => expect(foreign.result.current.available).toBe(true));
    const same = renderHook(() => useIntroTranslation("夜很静。"), {
      wrapper: wrapperWith("zh-CN"),
    });
    // The target is 简体中文 by default: nothing to translate.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(same.result.current.available).toBe(false);
  });
});

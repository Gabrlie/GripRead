// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { tocListing } from "../../test/toc";
import { TocSuggestionPrompt } from "./TocSuggestionPrompt";

afterEach(cleanup);

function runtimeWith(reader: Record<string, unknown>) {
  return new AppRuntime({
    library: { listBooks: vi.fn(async () => []), onImportProgress: vi.fn(async () => () => {}) },
    reader,
    settings: {},
    sync: {},
    sources: {},
  } as unknown as AppServices);
}

describe("the contents question", () => {
  it("is asked once, by the first page, and the answer is kept with the book", async () => {
    const save = vi.fn(async (_id: string, settings: unknown) => settings);
    const suggestion = vi.fn(async () => ({
      kind: "rule",
      ruleId: "odd",
      ruleName: "六角括号",
      titles: ["〔1〕开始", "〔2〕继续"],
    }));
    const runtime = runtimeWith({
      tocSuggestion: suggestion,
      listToc: vi.fn(async () => tocListing()),
      saveBookTocSettings: save,
    });
    const answered = vi.fn();
    render(
      <RuntimeContext.Provider value={runtime}>
        <TocSuggestionPrompt bookId="b1" onAnswered={answered} />
        {/* The detail page under the reader does not ask again. */}
        <TocSuggestionPrompt bookId="b1" />
      </RuntimeContext.Provider>,
    );
    expect(await screen.findByText("〔1〕开始")).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(suggestion).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "这本书使用它" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        "b1",
        expect.objectContaining({ ruleId: "odd", asked: true }),
      ),
    );
    await waitFor(() => expect(answered).toHaveBeenCalledOnce());
  });

  it("counts closing it as 不用了", async () => {
    const save = vi.fn(async (_id: string, settings: unknown) => settings);
    const runtime = runtimeWith({
      tocSuggestion: vi.fn(async () => ({
        kind: "inner",
        ruleId: "",
        ruleName: "",
        titles: ["第一章", "第二章"],
      })),
      listToc: vi.fn(async () => tocListing()),
      saveBookTocSettings: save,
    });
    render(
      <RuntimeContext.Provider value={runtime}>
        <TocSuggestionPrompt bookId="b2" />
      </RuntimeContext.Provider>,
    );
    await screen.findByText("第一章");
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        "b2",
        expect.objectContaining({ asked: true, innerChapters: false }),
      ),
    );
  });
});

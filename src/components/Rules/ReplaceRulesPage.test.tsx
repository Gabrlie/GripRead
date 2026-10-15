// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaderService } from "../../services/contracts";
import { ReplaceRulesPage } from "./ReplaceRulesPage";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const RULES = '[{"name":"去广告","pattern":"广告","replacement":"","isRegex":false}]';

function service() {
  return {
    listReplaceRules: vi.fn(async () => []),
    importReplaceRules: vi.fn(async () => []),
    exportReplaceRules: vi.fn(async () => "[]"),
    fetchRuleText: vi.fn(async () => RULES),
    pickRuleFile: vi.fn(async () => RULES),
  } as unknown as ReaderService;
}

describe("替换净化 import", () => {
  it("reads rules from an address or a file into the import box", async () => {
    const reader = service();
    render(<ReplaceRulesPage service={reader} onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "导入" }));
    await userEvent.click(screen.getByRole("button", { name: "网络导入" }));
    await userEvent.type(screen.getByLabelText("规则地址"), "https://example.com/rules.json");
    await userEvent.click(screen.getByRole("button", { name: "获取" }));
    expect(reader.fetchRuleText).toHaveBeenCalledWith("https://example.com/rules.json");
    await waitFor(() =>
      expect((screen.getByLabelText("规则 JSON") as HTMLTextAreaElement).value).toBe(RULES),
    );
    // The address is remembered for next time.
    await userEvent.click(screen.getByRole("button", { name: "网络导入" }));
    expect(screen.getByRole("button", { name: "https://example.com/rules.json" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "本地导入" }));
    expect(reader.pickRuleFile).toHaveBeenCalled();
    const [importButton] = screen
      .getAllByRole("button", { name: "导入" })
      .filter((button) => button.closest("[role=dialog]"));
    await userEvent.click(importButton);
    expect(reader.importReplaceRules).toHaveBeenCalledWith(RULES);
  });
});

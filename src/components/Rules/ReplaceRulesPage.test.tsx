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
    previewReplaceRules: vi.fn(async () => ({ items: [], skipped: 0 })),
    exportReplaceRules: vi.fn(async () => "[]"),
    fetchRuleText: vi.fn(async () => RULES),
    pickRuleFile: vi.fn(async () => RULES),
  } as unknown as ReaderService;
}

describe("替换净化 import", () => {
  it("lists the rules of an address first and imports the chosen ones", async () => {
    const reader = service();
    const rule = {
      id: "",
      name: "去广告",
      group: "",
      pattern: "广告",
      replacement: "",
      isRegex: false,
      scope: "",
      scopeTitle: false,
      scopeContent: true,
      enabled: true,
      serial: 0,
    };
    reader.previewReplaceRules = vi.fn(async () => ({
      items: [
        { rule, existing: false },
        { rule: { ...rule, name: "已有", pattern: "旧" }, existing: true },
      ],
      skipped: 1,
    }));
    reader.importReplaceRules = vi.fn(async () => [rule]);
    render(<ReplaceRulesPage service={reader} onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "更多" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /网络导入/ }));
    await userEvent.type(screen.getByLabelText("规则地址"), "https://example.com/rules.json");
    await userEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(reader.fetchRuleText).toHaveBeenCalledWith("https://example.com/rules.json");
    expect(reader.previewReplaceRules).toHaveBeenCalledWith(RULES);
    // A rule already here starts unchosen.
    expect(((await screen.findByLabelText("导入 去广告")) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("导入 已有") as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /导入 1/ }));
    await waitFor(() => expect(reader.importReplaceRules).toHaveBeenCalledWith(RULES, [0]));
  });
});

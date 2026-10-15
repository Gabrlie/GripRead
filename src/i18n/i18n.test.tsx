// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "./en";
import { format, setLanguage, t, useT } from "./index";
import { zhCN } from "./zh-CN";

afterEach(() => {
  cleanup();
  setLanguage("system");
});

function Title() {
  const t = useT();
  return <h1>{t("settings.title")}</h1>;
}

describe("interface languages", () => {
  it("fills placeholders and picks English plurals by count", () => {
    expect(format("已连接 {address}", { address: "a.example" })).toBe("已连接 a.example");
    expect(format("{count} {count|day|days}", { count: 1 })).toBe("1 day");
    expect(format("{count} {count|day|days}", { count: 7 })).toBe("7 days");
    expect(format("可用 {url}")).toBe("可用 {url}");
  });

  it("follows the chosen language at once and back to the system's", () => {
    render(<Title />);
    expect(screen.getByRole("heading").textContent).toBe("设置");
    act(() => setLanguage("en"));
    expect(screen.getByRole("heading").textContent).toBe("Settings");
    expect(document.documentElement.lang).toBe("en");
    expect(t("common.days", { count: 30 })).toBe("30 days");
    act(() => setLanguage("system"));
    expect(screen.getByRole("heading").textContent).toBe("设置");
    expect(document.documentElement.lang).toBe("zh-Hans");
  });

  it("has every key in English, with the same placeholders", () => {
    const names = (text: string) =>
      [...text.matchAll(/\{(\w+)/g)]
        .map((match) => match[1])
        .sort()
        .join(",");
    for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
      expect(en[key], key).toBeTruthy();
      expect(names(en[key]).replace(/(\w+)(,\1)+/g, "$1"), key).toBe(
        names(zhCN[key]).replace(/(\w+)(,\1)+/g, "$1"),
      );
    }
  });
});

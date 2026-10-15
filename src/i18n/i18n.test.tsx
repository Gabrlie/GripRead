// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "./en";
import { errorText, format, setLanguage, t, useT } from "./index";
import { zhCN } from "./zh-CN";

/** Every area of the Chinese texts, which define the keys. */
const AREAS = import.meta.glob<Record<string, Record<string, string>>>("./zh-CN/*.ts", {
  eager: true,
});

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

  it("translates keyed errors and keeps the message of others", () => {
    const error = {
      message: "没有这个书源：a.com",
      key: "sourceMissingUrl",
      params: { url: "a.com" },
    };
    expect(errorText(error)).toBe("没有这个书源：a.com");
    setLanguage("en");
    expect(errorText(error)).toBe("No such source: a.com");
    expect(errorText({ message: "磁盘已满" })).toBe("磁盘已满");
    expect(errorText({ message: "旧服务器", key: "somethingNew" })).toBe("旧服务器");
  });

  it("defines each key in one area only", () => {
    const owners = new Map<string, string>();
    for (const [file, module] of Object.entries(AREAS)) {
      if (file.endsWith("index.ts")) continue;
      for (const area of Object.values(module))
        for (const key of Object.keys(area)) {
          expect(owners.get(key), `${key} in ${file}`).toBeUndefined();
          owners.set(key, file);
        }
    }
    expect(owners.size).toBe(Object.keys(zhCN).length);
  });

  it("has every key in English, with the same placeholders", () => {
    const names = (text: string) =>
      [...new Set([...text.matchAll(/\{(\w+)/g)].map((match) => match[1]))].sort().join(",");
    for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
      expect(en[key], key).toBeTruthy();
      expect(names(en[key]), key).toBe(names(zhCN[key]));
    }
  });
});

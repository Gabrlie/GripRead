import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import type { LogEntry } from "../types/generated";
import { logExport, logText } from "./logs";

afterEach(() => setLanguage("zh-CN"));

const keyed: LogEntry = {
  time: 0,
  level: "warn",
  area: "source",
  message: "甲站 搜索失败：网站返回 403",
  key: "searchFailed",
  params: {
    source: "甲站",
    error: "网站返回 403",
    errorKey: "bookNoFile",
    errorParams: JSON.stringify({ title: "剑来" }),
  },
};

describe("日志的语言", () => {
  it("words keyed entries in the interface language, errors included", () => {
    expect(logText(keyed)).toBe("甲站 搜索失败：《剑来》没有书籍文件。");
    setLanguage("en");
    expect(logText(keyed)).toBe('甲站: search failed: "剑来" has no book file.');
    // Entries written before keys, and keys this version lacks, read as written.
    expect(logText({ ...keyed, key: undefined, params: {} })).toBe(keyed.message);
    expect(logText({ ...keyed, key: "somethingNew" })).toBe(keyed.message);
  });

  it("exports in the interface language", () => {
    setLanguage("en");
    const text = logExport([keyed], "0.2.2");
    expect(text.split("\n")[0]).toBe("GripRead 0.2.2 log");
    expect(text).toContain("[source] 甲站: search failed");
  });
});

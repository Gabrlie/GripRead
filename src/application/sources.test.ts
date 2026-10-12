import { describe, expect, it } from "vitest";
import type { BookSourceSummary } from "../types/generated";
import {
  filterSources,
  formatRespondTime,
  sortSources,
  sourceError,
  sourceGroups,
  splitGroups,
} from "./sources";

function source(overrides: Partial<BookSourceSummary>): BookSourceSummary {
  return {
    url: "https://a.com",
    name: "甲",
    group: "",
    enabled: true,
    enabledExplore: true,
    hasExplore: false,
    hasSearch: true,
    hasLogin: false,
    customOrder: 0,
    weight: 0,
    lastUpdateTime: 0,
    respondTime: 180000,
    comment: "",
    ...overrides,
  };
}

const list = [
  source({ url: "https://b.com", name: "乙", group: "常用;API", customOrder: 2, respondTime: 300 }),
  source({ url: "https://a.com", name: "甲", group: "常用", enabled: false, customOrder: 1 }),
  source({
    url: "https://c.com",
    name: "丙",
    hasExplore: true,
    enabledExplore: false,
    hasLogin: true,
    customOrder: 0,
    lastUpdateTime: 9,
    comment: "// Error: 连接失败\n\n说明",
  }),
];

describe("source lists", () => {
  it("collects groups and filters like Legado", () => {
    expect(splitGroups("常用;API，精品")).toEqual(["常用", "API", "精品"]);
    expect(sourceGroups(list)).toEqual(["常用", "API"]);
    const names = (items: BookSourceSummary[]) => items.map((item) => item.name);
    expect(names(filterSources(list, "", { kind: "disabled" }))).toEqual(["甲"]);
    expect(names(filterSources(list, "", { kind: "ungrouped" }))).toEqual(["丙"]);
    expect(names(filterSources(list, "", { kind: "exploreOff" }))).toEqual(["丙"]);
    expect(names(filterSources(list, "", { kind: "login" }))).toEqual(["丙"]);
    expect(names(filterSources(list, "", { kind: "group", name: "API" }))).toEqual(["乙"]);
    expect(names(filterSources(list, "B.COM", { kind: "all" }))).toEqual(["乙"]);
    expect(names(filterSources(list, "连接", { kind: "all" }))).toEqual(["丙"]);
  });

  it("sorts by Legado's orders", () => {
    const names = (items: BookSourceSummary[]) => items.map((item) => item.name);
    expect(names(sortSources(list, "manual"))).toEqual(["丙", "甲", "乙"]);
    expect(names(sortSources(list, "manual", true))).toEqual(["乙", "甲", "丙"]);
    expect(names(sortSources(list, "respond"))[0]).toBe("乙");
    expect(names(sortSources(list, "update"))[0]).toBe("丙");
    expect(names(sortSources(list, "enabled")).at(-1)).toBe("甲");
  });

  it("reads check errors and response times", () => {
    expect(sourceError(list[2])).toBe("连接失败");
    expect(sourceError(list[0])).toBeNull();
    expect(formatRespondTime(820)).toBe("820 毫秒");
    expect(formatRespondTime(1500)).toBe("1.5 秒");
    expect(formatRespondTime(181200)).toBe("超时");
  });
});

describe("智能排序", () => {
  it("puts working sources first, then the quicker ones", () => {
    const sources = [
      source({ url: "1", name: "失效", group: "网站失效", respondTime: 100 }),
      source({ url: "2", name: "慢", respondTime: 5000 }),
      source({ url: "3", name: "禁用", enabled: false, respondTime: 50 }),
      source({ url: "4", name: "快", respondTime: 800 }),
      source({ url: "5", name: "报错", comment: "// Error: 搜索结果为空", respondTime: 200 }),
    ];
    expect(sortSources(sources, "weight").map((item) => item.name)).toEqual([
      "快",
      "慢",
      "失效",
      "报错",
      "禁用",
    ]);
  });
});

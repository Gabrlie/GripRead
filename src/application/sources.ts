import type { BookSourceSummary } from "../types/generated";
import { t } from "../i18n";

/** Legado's 书源管理 filters. */
export type SourceFilter =
  | { kind: "all" }
  | { kind: "enabled" }
  | { kind: "disabled" }
  | { kind: "login" }
  | { kind: "ungrouped" }
  | { kind: "exploreOn" }
  | { kind: "exploreOff" }
  | { kind: "group"; name: string };

/** Legado's 书源管理 sort orders. */
export type SourceSort = "manual" | "weight" | "name" | "url" | "update" | "respond" | "enabled";

export const sourceSorts = (): [SourceSort, string][] => [
  ["manual", t("src.sort.manual")],
  ["weight", t("src.sort.weight")],
  ["name", t("src.sort.name")],
  ["url", t("src.sort.url")],
  ["update", t("src.sort.update")],
  ["respond", t("src.sort.respond")],
  ["enabled", t("src.sort.enabled")],
];

export const basicFilters = (): [SourceFilter, string][] => [
  [{ kind: "all" }, t("downloads.all")],
  [{ kind: "enabled" }, t("src.filter.enabled")],
  [{ kind: "disabled" }, t("src.filter.disabled")],
  [{ kind: "login" }, t("src.needsLogin")],
  [{ kind: "ungrouped" }, t("src.filter.ungrouped")],
  [{ kind: "exploreOn" }, t("src.filter.exploreOn")],
  [{ kind: "exploreOff" }, t("src.exploreOff")],
];

/** Splits Legado's group text (`,` `;` separated) into names. */
export function splitGroups(group: string): string[] {
  return group
    .split(/[,;，；]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Every group name in use, in first-seen order. */
export function sourceGroups(sources: BookSourceSummary[]): string[] {
  const names: string[] = [];
  for (const source of sources)
    for (const name of splitGroups(source.group)) if (!names.includes(name)) names.push(name);
  return names;
}

export function sameFilter(a: SourceFilter, b: SourceFilter): boolean {
  return a.kind === b.kind && (a.kind !== "group" || a.name === (b as typeof a).name);
}

function matchesFilter(source: BookSourceSummary, filter: SourceFilter): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "enabled":
      return source.enabled;
    case "disabled":
      return !source.enabled;
    case "login":
      return source.hasLogin;
    case "ungrouped":
      return splitGroups(source.group).length === 0;
    case "exploreOn":
      return source.hasExplore && source.enabledExplore;
    case "exploreOff":
      return source.hasExplore && !source.enabledExplore;
    case "group":
      return splitGroups(source.group).includes(filter.name);
  }
}

/** The sources a query and filter leave; the query matches name, address, group, and comment. */
export function filterSources(
  sources: BookSourceSummary[],
  query: string,
  filter: SourceFilter,
): BookSourceSummary[] {
  const needle = query.trim().toLowerCase();
  return sources.filter(
    (source) =>
      matchesFilter(source, filter) &&
      (!needle ||
        [source.name, source.url, source.group, source.comment].some((field) =>
          field.toLowerCase().includes(needle),
        )),
  );
}

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });

/** The groups a failed 校验 adds (Rust `CHECK_GROUPS`). */
const CHECK_FAILURES = new Set([
  "网站失效",
  "js失效",
  "校验超时",
  "搜索失效",
  "发现失效",
  "详情失效",
  "目录失效",
  "正文失效",
  "搜索链接规则为空",
  "发现规则为空",
]);

/** Whether the last 校验 found this source broken. */
export function sourceFailed(source: BookSourceSummary): boolean {
  return (
    splitGroups(source.group).some((group) => CHECK_FAILURES.has(group)) ||
    sourceError(source) !== null
  );
}

/**
 * 智能排序: sources that work first — enabled, without a failed check, and
 * quicker to answer — then by weight and the manual order.
 */
function smartOrder(a: BookSourceSummary, b: BookSourceSummary): number {
  return (
    Number(b.enabled) - Number(a.enabled) ||
    Number(sourceFailed(a)) - Number(sourceFailed(b)) ||
    a.respondTime - b.respondTime ||
    b.weight - a.weight ||
    a.customOrder - b.customOrder
  );
}

export function sortSources(
  sources: BookSourceSummary[],
  sort: SourceSort,
  reverse = false,
): BookSourceSummary[] {
  const compare: Record<SourceSort, (a: BookSourceSummary, b: BookSourceSummary) => number> = {
    manual: (a, b) => a.customOrder - b.customOrder,
    weight: smartOrder,
    name: (a, b) => collator.compare(a.name, b.name),
    url: (a, b) => a.url.localeCompare(b.url),
    update: (a, b) => b.lastUpdateTime - a.lastUpdateTime,
    respond: (a, b) => a.respondTime - b.respondTime,
    enabled: (a, b) => Number(b.enabled) - Number(a.enabled) || collator.compare(a.name, b.name),
  };
  const sorted = [...sources].sort(
    (a, b) => compare[sort](a, b) || collator.compare(a.name, b.name),
  );
  return reverse ? sorted.reverse() : sorted;
}

/** The first line of a check error kept in the comment, if any. */
export function sourceError(source: BookSourceSummary): string | null {
  const first = source.comment.split("\n")[0] ?? "";
  return first.startsWith("// Error: ") ? first.slice("// Error: ".length) : null;
}

/** Response time as Legado shows it in the list. */
export function formatRespondTime(ms: number): string {
  if (ms >= 180000) return t("src.timeout");
  if (ms >= 1000) return t("src.seconds", { seconds: (ms / 1000).toFixed(1) });
  return t("src.ms", { ms });
}

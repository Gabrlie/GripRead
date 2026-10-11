import type { ReaderTool } from "../../types/generated";

/** Label and icon of each bottom bar tool; 夜间 shows its opposite mode. */
export const READER_TOOLS: Record<ReaderTool, { label: string; icon: string }> = {
  search: { label: "搜索", icon: "search" },
  "auto-page": { label: "自动翻页", icon: "schedule" },
  "read-aloud": { label: "朗读", icon: "headphones" },
  contents: { label: "目录", icon: "list" },
  style: { label: "界面", icon: "format_size" },
  night: { label: "夜间", icon: "dark_mode" },
  bookmark: { label: "书签", icon: "bookmark_add" },
  "replace-rules": { label: "替换", icon: "find_replace" },
  "toc-rules": { label: "目录规则", icon: "toc_rule" },
  encoding: { label: "编码", icon: "translate" },
  "more-settings": { label: "设置", icon: "settings" },
};

export const ALL_READER_TOOLS = Object.keys(READER_TOOLS) as ReaderTool[];

/** Mirrors `MAX_BOTTOM_TOOLS` in models.rs. */
export const MAX_BOTTOM_TOOLS = 7;

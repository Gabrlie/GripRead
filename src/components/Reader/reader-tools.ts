import type { ReaderTool } from "../../types/generated";
import { t } from "../../i18n";

/** Label and icon of each bottom bar tool; 夜间 shows its opposite mode. */
export const READER_TOOLS: Record<ReaderTool, { label: string; icon: string }> = {
  search: {
    get label() {
      return t("header.search");
    },
    icon: "search",
  },
  "auto-page": {
    get label() {
      return t("reader.tool.autoPage");
    },
    icon: "schedule",
  },
  "read-aloud": {
    get label() {
      return t("reader.tool.aloud");
    },
    icon: "headphones",
  },
  contents: {
    get label() {
      return t("detail.contents");
    },
    icon: "list",
  },
  style: {
    get label() {
      return t("style.main");
    },
    icon: "format_size",
  },
  night: {
    get label() {
      return t("reader.tool.night");
    },
    icon: "dark_mode",
  },
  bookmark: {
    get label() {
      return t("style.tap.bookmark");
    },
    icon: "bookmark_add",
  },
  "replace-rules": {
    get label() {
      return t("reader.tool.replace");
    },
    icon: "find_replace",
  },
  "toc-rules": {
    get label() {
      return t("reader.tool.tocRules");
    },
    icon: "toc_rule",
  },
  encoding: {
    get label() {
      return t("reader.tool.encoding");
    },
    icon: "translate",
  },
  "more-settings": {
    get label() {
      return t("nav.settings");
    },
    icon: "settings",
  },
};

export const ALL_READER_TOOLS = Object.keys(READER_TOOLS) as ReaderTool[];

/** Mirrors `MAX_BOTTOM_TOOLS` in models.rs. */
export const MAX_BOTTOM_TOOLS = 7;

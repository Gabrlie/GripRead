import { t } from "../../i18n";
/** One field of Legado's tabbed source editor. */
export interface SourceField {
  /** The key in the source, or in `section` when it is a rule. */
  key: string;
  label: string;
  section?: "ruleSearch" | "ruleExplore" | "ruleBookInfo" | "ruleToc" | "ruleContent";
  /** A rule or script, shown in a monospace box. */
  code?: boolean;
  hint?: string;
}

export interface SourceTab {
  id: string;
  label: string;
  fields: SourceField[];
  /** Switches shown above the fields. */
  switches?: { key: string; label: string; fallback: boolean }[];
}

const listRules = (section: "ruleSearch" | "ruleExplore"): SourceField[] => [
  {
    key: "bookList",
    get label() {
      return t("field.book-list-rule");
    },
    section,
    code: true,
  },
  {
    key: "name",
    get label() {
      return t("field.title-rule");
    },
    section,
    code: true,
  },
  {
    key: "author",
    get label() {
      return t("field.author-rule");
    },
    section,
    code: true,
  },
  {
    key: "kind",
    get label() {
      return t("field.category-rule");
    },
    section,
    code: true,
  },
  {
    key: "wordCount",
    get label() {
      return t("field.length-rule");
    },
    section,
    code: true,
  },
  {
    key: "lastChapter",
    get label() {
      return t("field.latest-chapter-rule");
    },
    section,
    code: true,
  },
  {
    key: "intro",
    get label() {
      return t("field.introduction-rule");
    },
    section,
    code: true,
  },
  {
    key: "coverUrl",
    get label() {
      return t("field.cover-rule");
    },
    section,
    code: true,
  },
  {
    key: "bookUrl",
    get label() {
      return t("field.details-url-rule");
    },
    section,
    code: true,
  },
];

export const SOURCE_TABS: SourceTab[] = [
  {
    id: "basic",
    get label() {
      return t("field.basic");
    },
    switches: [
      {
        key: "enabled",
        get label() {
          return t("field.enabled");
        },
        fallback: true,
      },
      {
        key: "enabledExplore",
        get label() {
          return t("field.discovery-enabled");
        },
        fallback: true,
      },
      {
        key: "enabledCookieJar",
        get label() {
          return t("field.keep-cookies");
        },
        fallback: true,
      },
    ],
    fields: [
      {
        key: "bookSourceUrl",
        get label() {
          return t("field.source-url");
        },
        get hint() {
          return t("field.the-source-s-unique-identity");
        },
      },
      {
        key: "bookSourceName",
        get label() {
          return t("field.source-name");
        },
      },
      {
        key: "bookSourceGroup",
        get label() {
          return t("field.source-group");
        },
        get hint() {
          return t("field.separate-several-groups-with-commas");
        },
      },
      {
        key: "bookSourceComment",
        get label() {
          return t("field.source-comment");
        },
      },
      {
        key: "loginUrl",
        get label() {
          return t("field.login-address");
        },
        code: true,
        get hint() {
          return t("field.a-login-script-or-the-login-page-address");
        },
      },
      {
        key: "loginUi",
        get label() {
          return t("field.login-form");
        },
        code: true,
        get hint() {
          return t("field.json-array-name-type-action");
        },
      },
      {
        key: "loginCheckJs",
        get label() {
          return t("field.login-check-js");
        },
        code: true,
      },
      {
        key: "coverDecodeJs",
        get label() {
          return t("field.cover-decoding");
        },
        code: true,
      },
      {
        key: "bookUrlPattern",
        get label() {
          return t("field.book-url-pattern");
        },
        code: true,
      },
      {
        key: "header",
        get label() {
          return t("field.request-headers");
        },
        code: true,
        get hint() {
          return t("field.json-or-an-js-script");
        },
      },
      {
        key: "variableComment",
        get label() {
          return t("field.variable-notes");
        },
      },
      {
        key: "concurrentRate",
        get label() {
          return t("field.rate");
        },
        get hint() {
          return t("field.e-g-1000-ms-or-5-60000");
        },
      },
      { key: "jsLib", label: "jsLib", code: true },
    ],
  },
  {
    id: "search",
    get label() {
      return t("field.search");
    },
    fields: [
      {
        key: "searchUrl",
        get label() {
          return t("field.search-address");
        },
        code: true,
        get hint() {
          return t("field.use-key-and-page");
        },
      },
      {
        key: "checkKeyWord",
        get label() {
          return t("field.check-keyword");
        },
        section: "ruleSearch",
      },
      ...listRules("ruleSearch"),
    ],
  },
  {
    id: "explore",
    get label() {
      return t("field.discover");
    },
    fields: [
      {
        key: "exploreUrl",
        get label() {
          return t("field.discovery-address-rule");
        },
        code: true,
        get hint() {
          return t("field.name-address-separated-by-or-new-lines");
        },
      },
      ...listRules("ruleExplore"),
    ],
  },
  {
    id: "info",
    get label() {
      return t("field.details");
    },
    fields: [
      {
        key: "init",
        get label() {
          return t("field.preprocessing-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "name",
        get label() {
          return t("field.title-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "author",
        get label() {
          return t("field.author-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "kind",
        get label() {
          return t("field.category-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "wordCount",
        get label() {
          return t("field.length-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "lastChapter",
        get label() {
          return t("field.latest-chapter-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "intro",
        get label() {
          return t("field.introduction-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "coverUrl",
        get label() {
          return t("field.cover-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "tocUrl",
        get label() {
          return t("field.contents-url-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "canReName",
        get label() {
          return t("field.allow-changing-title-and-author");
        },
        section: "ruleBookInfo",
        code: true,
      },
      {
        key: "downloadUrls",
        get label() {
          return t("field.download-url-rule");
        },
        section: "ruleBookInfo",
        code: true,
      },
    ],
  },
  {
    id: "toc",
    get label() {
      return t("field.contents");
    },
    fields: [
      {
        key: "preUpdateJs",
        get label() {
          return t("field.js-before-updating-contents");
        },
        section: "ruleToc",
        code: true,
      },
      {
        key: "chapterList",
        get label() {
          return t("field.chapter-list-rule");
        },
        section: "ruleToc",
        code: true,
      },
      {
        key: "chapterName",
        get label() {
          return t("field.chapter-title-rule");
        },
        section: "ruleToc",
        code: true,
      },
      {
        key: "chapterUrl",
        get label() {
          return t("field.chapter-url-rule");
        },
        section: "ruleToc",
        code: true,
      },
      {
        key: "formatJs",
        get label() {
          return t("field.format-rule");
        },
        section: "ruleToc",
        code: true,
      },
      {
        key: "isVolume",
        get label() {
          return t("field.volume-mark");
        },
        section: "ruleToc",
        code: true,
      },
      {
        key: "updateTime",
        get label() {
          return t("field.update-time");
        },
        section: "ruleToc",
        code: true,
      },
      {
        key: "isVip",
        get label() {
          return t("field.vip-mark");
        },
        section: "ruleToc",
        code: true,
      },
      {
        key: "isPay",
        get label() {
          return t("field.purchase-mark");
        },
        section: "ruleToc",
        code: true,
      },
      {
        key: "nextTocUrl",
        get label() {
          return t("field.contents-next-page-rule");
        },
        section: "ruleToc",
        code: true,
      },
    ],
  },
  {
    id: "content",
    get label() {
      return t("field.text");
    },
    fields: [
      {
        key: "content",
        get label() {
          return t("field.text-rule");
        },
        section: "ruleContent",
        code: true,
      },
      {
        key: "title",
        get label() {
          return t("field.chapter-title-rule");
        },
        section: "ruleContent",
        code: true,
      },
      {
        key: "nextContentUrl",
        get label() {
          return t("field.text-next-page-rule");
        },
        section: "ruleContent",
        code: true,
      },
      { key: "webJs", label: "WebView JS", section: "ruleContent", code: true },
      {
        key: "sourceRegex",
        get label() {
          return t("field.resource-pattern");
        },
        section: "ruleContent",
        code: true,
      },
      {
        key: "replaceRegex",
        get label() {
          return t("field.replace-rule");
        },
        section: "ruleContent",
        code: true,
      },
      {
        key: "imageStyle",
        get label() {
          return t("field.image-style");
        },
        section: "ruleContent",
      },
      {
        key: "imageDecode",
        get label() {
          return t("field.image-decoding");
        },
        section: "ruleContent",
        code: true,
      },
      {
        key: "payAction",
        get label() {
          return t("field.purchase-action");
        },
        section: "ruleContent",
        code: true,
      },
    ],
  },
];

export type SourceJson = Record<string, unknown>;

/** A field's text in the source being edited. */
export function fieldValue(source: SourceJson, field: SourceField): string {
  const holder = field.section ? sectionOf(source, field.section) : source;
  const value = holder[field.key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function sectionOf(source: SourceJson, section: string): SourceJson {
  const value = source[section];
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed as SourceJson;
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as SourceJson) : {};
}

/** The source with one field changed; an empty field is removed. */
export function withField(source: SourceJson, field: SourceField, text: string): SourceJson {
  const next: SourceJson = { ...source };
  if (!field.section) {
    if (text === "") delete next[field.key];
    else next[field.key] = text;
    return next;
  }
  const section = { ...sectionOf(source, field.section) };
  if (text === "") delete section[field.key];
  else section[field.key] = text;
  next[field.section] = section;
  return next;
}

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
  { key: "bookList", label: "书籍列表规则", section, code: true },
  { key: "name", label: "书名规则", section, code: true },
  { key: "author", label: "作者规则", section, code: true },
  { key: "kind", label: "分类规则", section, code: true },
  { key: "wordCount", label: "字数规则", section, code: true },
  { key: "lastChapter", label: "最新章节规则", section, code: true },
  { key: "intro", label: "简介规则", section, code: true },
  { key: "coverUrl", label: "封面规则", section, code: true },
  { key: "bookUrl", label: "详情页 URL 规则", section, code: true },
];

export const SOURCE_TABS: SourceTab[] = [
  {
    id: "basic",
    label: "基本",
    switches: [
      { key: "enabled", label: "启用", fallback: true },
      { key: "enabledExplore", label: "启用发现", fallback: true },
      { key: "enabledCookieJar", label: "保存 Cookie", fallback: true },
    ],
    fields: [
      { key: "bookSourceUrl", label: "书源 URL", hint: "书源的唯一标识" },
      { key: "bookSourceName", label: "书源名称" },
      { key: "bookSourceGroup", label: "书源分组", hint: "多个分组用逗号隔开" },
      { key: "bookSourceComment", label: "书源注释" },
      { key: "loginUrl", label: "登录地址", code: true, hint: "登录脚本，或登录网页地址" },
      { key: "loginUi", label: "登录界面", code: true, hint: "JSON 数组：name、type、action" },
      { key: "loginCheckJs", label: "登录检查 JS", code: true },
      { key: "coverDecodeJs", label: "封面解密", code: true },
      { key: "bookUrlPattern", label: "书籍 URL 正则", code: true },
      { key: "header", label: "请求头", code: true, hint: "JSON，或 @js: 脚本" },
      { key: "variableComment", label: "变量说明" },
      { key: "concurrentRate", label: "并发率", hint: "如 1000（毫秒）或 5/60000" },
      { key: "jsLib", label: "jsLib", code: true },
    ],
  },
  {
    id: "search",
    label: "搜索",
    fields: [
      { key: "searchUrl", label: "搜索地址", code: true, hint: "可用 {{key}} 与 {{page}}" },
      { key: "checkKeyWord", label: "校验关键字", section: "ruleSearch" },
      ...listRules("ruleSearch"),
    ],
  },
  {
    id: "explore",
    label: "发现",
    fields: [
      {
        key: "exploreUrl",
        label: "发现地址规则",
        code: true,
        hint: "名称::地址，用 && 或换行分隔",
      },
      ...listRules("ruleExplore"),
    ],
  },
  {
    id: "info",
    label: "详情",
    fields: [
      { key: "init", label: "预处理规则", section: "ruleBookInfo", code: true },
      { key: "name", label: "书名规则", section: "ruleBookInfo", code: true },
      { key: "author", label: "作者规则", section: "ruleBookInfo", code: true },
      { key: "kind", label: "分类规则", section: "ruleBookInfo", code: true },
      { key: "wordCount", label: "字数规则", section: "ruleBookInfo", code: true },
      { key: "lastChapter", label: "最新章节规则", section: "ruleBookInfo", code: true },
      { key: "intro", label: "简介规则", section: "ruleBookInfo", code: true },
      { key: "coverUrl", label: "封面规则", section: "ruleBookInfo", code: true },
      { key: "tocUrl", label: "目录 URL 规则", section: "ruleBookInfo", code: true },
      { key: "canReName", label: "允许修改书名作者", section: "ruleBookInfo", code: true },
      { key: "downloadUrls", label: "下载 URL 规则", section: "ruleBookInfo", code: true },
    ],
  },
  {
    id: "toc",
    label: "目录",
    fields: [
      { key: "preUpdateJs", label: "目录更新前 JS", section: "ruleToc", code: true },
      { key: "chapterList", label: "目录列表规则", section: "ruleToc", code: true },
      { key: "chapterName", label: "章节名称规则", section: "ruleToc", code: true },
      { key: "chapterUrl", label: "章节 URL 规则", section: "ruleToc", code: true },
      { key: "formatJs", label: "格式化规则", section: "ruleToc", code: true },
      { key: "isVolume", label: "卷名标识", section: "ruleToc", code: true },
      { key: "updateTime", label: "更新时间", section: "ruleToc", code: true },
      { key: "isVip", label: "VIP 标识", section: "ruleToc", code: true },
      { key: "isPay", label: "购买标识", section: "ruleToc", code: true },
      { key: "nextTocUrl", label: "目录下一页规则", section: "ruleToc", code: true },
    ],
  },
  {
    id: "content",
    label: "正文",
    fields: [
      { key: "content", label: "正文规则", section: "ruleContent", code: true },
      { key: "title", label: "章节名称规则", section: "ruleContent", code: true },
      { key: "nextContentUrl", label: "正文下一页规则", section: "ruleContent", code: true },
      { key: "webJs", label: "WebView JS", section: "ruleContent", code: true },
      { key: "sourceRegex", label: "资源正则", section: "ruleContent", code: true },
      { key: "replaceRegex", label: "替换规则", section: "ruleContent", code: true },
      { key: "imageStyle", label: "图片样式", section: "ruleContent" },
      { key: "imageDecode", label: "图片解密", section: "ruleContent", code: true },
      { key: "payAction", label: "购买操作", section: "ruleContent", code: true },
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

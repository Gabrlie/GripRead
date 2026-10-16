import { t, type MessageKey } from "../i18n";
import type { EngineKind, TranslationEngine } from "../types/generated";

/** The languages books are detected in and translated into (`translation.rs`). */
export const LANGUAGES = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru"] as const;

export function languageName(code: string | null | undefined): string {
  if (!code) return t("translation.book.unknown");
  const key = `translation.lang.${code}` as MessageKey;
  const name = t(key);
  return name === key ? code : name;
}

/** Services offered when adding an engine: kind, address, and a model to start from. */
export const PRESETS: {
  id: string;
  name: string | MessageKey;
  kind: EngineKind;
  baseUrl: string;
  model: string;
}[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "openAi",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openAi",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  {
    id: "qwen",
    name: "translation.preset.qwen",
    kind: "openAi",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  {
    id: "kimi",
    name: "translation.preset.kimi",
    kind: "openAi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openAi",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "",
  },
  {
    id: "ollama",
    name: "translation.preset.ollama",
    kind: "openAi",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5",
  },
  { id: "claude", name: "Claude", kind: "claude", baseUrl: "", model: "claude-haiku-5-5" },
  { id: "gemini", name: "Gemini", kind: "gemini", baseUrl: "", model: "gemini-2.5-flash" },
  { id: "deepl", name: "DeepL", kind: "deepl", baseUrl: "", model: "" },
  {
    id: "deeplx",
    name: "translation.preset.deeplx",
    kind: "deeplx",
    baseUrl: "http://127.0.0.1:1188",
    model: "",
  },
  {
    id: "deeplxHosted",
    name: "translation.preset.deeplxHosted",
    kind: "deeplx",
    baseUrl: "https://api.deeplx.org/{apiKey}",
    model: "",
  },
];

export function presetName(preset: (typeof PRESETS)[number]): string {
  return preset.name.startsWith("translation.") ? t(preset.name as MessageKey) : preset.name;
}

/** A new engine from a preset, with a fresh id. */
export function engineFrom(preset: (typeof PRESETS)[number]): TranslationEngine {
  return {
    id: `engine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: presetName(preset),
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    model: preset.model,
    apiKey: "",
    prompt: "",
    headers: "",
  };
}

/** Whether a book in `language` reads as written in `target`. */
export function sameLanguage(language: string | null | undefined, target: string): boolean {
  return Boolean(language) && language!.toLowerCase() === target.toLowerCase();
}

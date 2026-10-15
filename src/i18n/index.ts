import { useSyncExternalStore } from "react";
import { en } from "./en";
import { zhCN, type MessageKey } from "./zh-CN";

export type { MessageKey } from "./zh-CN";

/** The interface languages; `zh-CN` defines the keys. */
export type Locale = "zh-CN" | "en";
/** 界面语言: a language, or the system's. */
export type LanguageChoice = Locale | "system";

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { "zh-CN": zhCN, en };
const STORAGE_KEY = "gripread.language";

export type Params = Record<string, string | number>;

function systemLocale(): Locale {
  const languages =
    typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  const first = languages.find(Boolean) ?? "zh-CN";
  return first.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function storedChoice(): LanguageChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "zh-CN" || value === "en" ? value : "system";
  } catch {
    return "system";
  }
}

let choice: LanguageChoice = storedChoice();
let locale: Locale = choice === "system" ? systemLocale() : choice;
const listeners = new Set<() => void>();

function applyDocumentLanguage() {
  if (typeof document !== "undefined")
    document.documentElement.lang = locale === "zh-CN" ? "zh-Hans" : "en";
}
applyDocumentLanguage();

export function currentLocale(): Locale {
  return locale;
}

export function languageChoice(): LanguageChoice {
  return choice;
}

/** Chooses the interface language; open screens follow at once. Kept on this device only. */
export function setLanguage(next: LanguageChoice) {
  choice = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Without storage the choice lasts until the app closes.
  }
  const resolved = next === "system" ? systemLocale() : next;
  if (resolved === locale) return;
  locale = resolved;
  applyDocumentLanguage();
  listeners.forEach((listener) => listener());
}

/** Calls `listener` when the interface language changes. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The text for `key` in the current language, with `{name}` placeholders
 * filled from `params`. A key with `|` variants picks by `count`: `one|other`.
 */
export function t(key: MessageKey, params?: Params): string {
  const template = DICTIONARIES[locale][key] ?? zhCN[key] ?? key;
  return format(template, params);
}

/** Fills `{name}` placeholders; `{count|one|other}` picks the English plural. */
export function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g, (whole, name, one, other) => {
    const value = params[name];
    if (value === undefined) return whole;
    if (one !== undefined) return Number(value) === 1 ? one : other;
    return String(value);
  });
}

/** `t` for components: they re-render when the language changes. */
export function useT(): typeof t {
  useSyncExternalStore(onLanguageChange, currentLocale, currentLocale);
  return t;
}

/** The current language, re-rendering on change. */
export function useLocale(): Locale {
  return useSyncExternalStore(onLanguageChange, currentLocale, currentLocale);
}

function intlLocale(): string {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

/** A date and time in the current language (month, day, hour, minute by default). */
export function formatDateTime(
  at: number | Date,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  },
): string {
  return new Date(at).toLocaleString(intlLocale(), options);
}

export function formatDate(at: number | Date): string {
  return new Date(at).toLocaleDateString(intlLocale());
}

export function formatClock(at: number | Date, seconds = false): string {
  return new Date(at).toLocaleTimeString(intlLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

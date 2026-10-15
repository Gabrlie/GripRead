import { vi } from "vitest";
import type { TranslationService } from "../services/contracts";
import type { BookTranslation, TranslationSettings } from "../types/generated";

export function translationSettings(
  overrides: Partial<TranslationSettings> = {},
): TranslationSettings {
  return {
    engines: [],
    defaultEngine: null,
    target: "zh-CN",
    display: "translated",
    autoTranslate: false,
    ahead: 2,
    ...overrides,
  };
}

/** A translation service with no engines and books in an unknown language. */
export function translationServiceMocks(
  overrides: Partial<TranslationService> = {},
): TranslationService {
  let settings = translationSettings();
  const books = new Map<string, BookTranslation>();
  const book = (bookId: string) =>
    books.get(bookId) ?? { bookId, language: null, translateTo: null };
  return {
    getSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (next) => (settings = next)),
    testEngine: vi.fn(async () => "测试译文"),
    getBook: vi.fn(async (bookId) => book(bookId)),
    setBook: vi.fn(async (bookId, translateTo) => {
      const next = { ...book(bookId), translateTo };
      books.set(bookId, next);
      return next;
    }),
    setLanguage: vi.fn(async (bookId, language) => {
      const next = { ...book(bookId), language };
      books.set(bookId, next);
      return next;
    }),
    ...overrides,
  };
}

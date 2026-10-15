import type { TranslationService } from "../services/contracts";
import type { BookTranslation, TranslationSettings } from "../types/generated";

/** 翻译 for the browser preview: settings in memory, a pretend engine. */
export function memoryTranslation(): TranslationService {
  let settings: TranslationSettings = {
    engines: [
      {
        id: "preview",
        name: "DeepSeek",
        kind: "openAi",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: "",
        prompt: "",
      },
    ],
    defaultEngine: "preview",
    target: "zh-CN",
    display: "translated",
    autoTranslate: false,
    ahead: 2,
  };
  const books = new Map<string, BookTranslation>();
  const book = (bookId: string) =>
    books.get(bookId) ?? { bookId, language: "zh-CN", translateTo: null };
  return {
    getSettings: async () => settings,
    saveSettings: async (next) => (settings = next),
    testEngine: async () => "夜很静，老房子记得每一个脚步。",
    getBook: async (bookId) => book(bookId),
    setBook: async (bookId, translateTo) => {
      const next = { ...book(bookId), translateTo };
      books.set(bookId, next);
      return next;
    },
    setLanguage: async (bookId, language) => {
      const next = { ...book(bookId), language };
      books.set(bookId, next);
      return next;
    },
    translateBook: async () => undefined,
    stopBook: async () => undefined,
    onBookProgress: async () => () => undefined,
  };
}

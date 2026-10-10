import { vi } from "vitest";
import type { ReaderService, SettingsService } from "../services/contracts";
import type { ReaderLocator, TocEntry, TocListing } from "../types/generated";

/** A directory listing produced by automatic detection. */
export function tocListing(entries: TocEntry[] = [], ruleName = "目录"): TocListing {
  return {
    entries,
    ruleId: entries.length ? "legado-2" : null,
    ruleName,
    settings: { ruleId: null, splitLongChapters: false },
  };
}

export function tocEntry(ordinal: number, title: string, locator: ReaderLocator): TocEntry {
  return { ordinal, title, volume: false, length: 0, locator };
}

/** Chapter rule methods of the reader service, resolving with empty results. */
export function ruleServiceMocks(): Pick<
  ReaderService,
  | "listTxtTocRules"
  | "saveTxtTocRule"
  | "deleteTxtTocRule"
  | "orderTxtTocRules"
  | "importTxtTocRules"
  | "exportTxtTocRules"
  | "testTxtTocRule"
  | "saveBookTocSettings"
> {
  return {
    listTxtTocRules: vi.fn(async () => []),
    saveTxtTocRule: vi.fn(async (rule) => rule),
    deleteTxtTocRule: vi.fn(async () => undefined),
    orderTxtTocRules: vi.fn(async () => []),
    importTxtTocRules: vi.fn(async () => []),
    exportTxtTocRules: vi.fn(async () => "[]"),
    testTxtTocRule: vi.fn(async () => []),
    saveBookTocSettings: vi.fn(async (_bookId, settings) => settings),
  };
}

/** Font asset methods of the settings service with an empty font list. */
export function fontServiceMocks(): Pick<
  SettingsService,
  "pickAndImportFont" | "listFonts" | "readFont" | "deleteFont"
> {
  return {
    pickAndImportFont: vi.fn(async () => null),
    listFonts: vi.fn(async () => []),
    readFont: vi.fn(async () => new ArrayBuffer(0)),
    deleteFont: vi.fn(async () => undefined),
  };
}

import { vi } from "vitest";
import type { ReaderService, SettingsService } from "../services/contracts";
import type { ReaderLocator, TocEntry, TocListing } from "../types/generated";
import { PREVIEW_NETWORK } from "../preview/network";

/** A directory listing produced by automatic detection. */
export function tocListing(entries: TocEntry[] = [], ruleName = "目录"): TocListing {
  return {
    entries,
    ruleId: entries.length ? "legado-2" : null,
    ruleName,
    settings: { ruleId: null, splitLongChapters: false, asked: false, innerChapters: false },
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

/** Asset methods of the settings service with an empty font list. */
export function fontServiceMocks(): Pick<
  SettingsService,
  | "pickAndImportFont"
  | "listFonts"
  | "readFont"
  | "deleteFont"
  | "pickBackgroundImage"
  | "getNetwork"
  | "saveNetwork"
  | "checkNetwork"
  | "networkState"
  | "onNetworkChange"
> {
  return {
    pickAndImportFont: vi.fn(async () => null),
    pickBackgroundImage: vi.fn(async () => null),
    listFonts: vi.fn(async () => []),
    readFont: vi.fn(async () => new ArrayBuffer(0)),
    deleteFont: vi.fn(async () => undefined),
    getNetwork: vi.fn(async () => PREVIEW_NETWORK),
    saveNetwork: vi.fn(async (settings) => settings),
    checkNetwork: vi.fn(async () => ({ millis: 10, detail: "ok" })),
    networkState: vi.fn(async () => ({})),
    onNetworkChange: vi.fn(async () => () => undefined),
  };
}

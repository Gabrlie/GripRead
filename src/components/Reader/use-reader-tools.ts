import { useCallback, useEffect, useRef, useState } from "react";
import type { AppRuntime } from "../../application/runtime";
import type {
  Bookmark,
  BookTocSettings,
  LibraryBook,
  TocListing,
  TxtEncodingInfo,
  TxtTocRule,
} from "../../types/generated";
import type { ReaderActions } from "./use-reader-actions";

const NO_LISTING: TocListing = {
  entries: [],
  ruleId: null,
  ruleName: "",
  settings: { ruleId: null, splitLongChapters: false },
};

/**
 * Per-book reader tools: the directory and the rule that produced it, the
 * shared chapter rule table, bookmarks, and encoding information. A saved
 * chapter setting completes independently of the dialog that started it and
 * participates in reader exit flushing; rule table edits refresh the
 * directory because automatic detection depends on every enabled rule.
 */
export function useReaderTools(
  activeBook: LibraryBook | null,
  runtime: AppRuntime,
  actions: ReaderActions,
) {
  const { sessionEpoch, fail, clearError } = actions;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<TocListing>(NO_LISTING);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [encodingInfo, setEncodingInfo] = useState<TxtEncodingInfo | null>(null);
  const [rules, setRules] = useState<TxtTocRule[]>([]);
  const [busy, setBusy] = useState(false);
  const pendingSettings = useRef<Promise<unknown> | null>(null);
  const failedSettings = useRef<{ bookId: string; settings: BookTocSettings } | null>(null);
  const bookId = activeBook?.book.id;
  const online = Boolean(activeBook?.online);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      // Online books have no TXT file and so no encoding.
      online ? Promise.resolve(null) : runtime.services.library.getTxtEncoding(bookId),
      runtime.services.reader.listToc(bookId),
      runtime.services.reader.listBookmarks(bookId),
      runtime.services.reader.listTxtTocRules(),
    ])
      .then(([encoding, toc, saved, table]) => {
        if (cancelled) return;
        setEncodingInfo(encoding);
        setListing(toc);
        setBookmarks(saved);
        setRules(table);
        setLoading(false);
      })
      .catch((failure) => {
        if (!cancelled) {
          setError(String(failure));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      setListing(NO_LISTING);
      setBookmarks([]);
      setEncodingInfo(null);
    };
  }, [bookId, online, runtime.services, revision]);

  /** Reads the directory again after anything that can change it. */
  const refreshDirectory = useCallback(
    async (target: string, epoch: number) => {
      runtime.shelf.invalidateChapterCache(target);
      const toc = await runtime.services.reader.listToc(target);
      if (epoch !== sessionEpoch.current) return;
      setListing(toc);
      await runtime.shelf.load(runtime.library.getSnapshot().books);
    },
    [runtime, sessionEpoch],
  );

  const writeSettings = useCallback(
    (target: string, settings: BookTocSettings) => {
      const epoch = sessionEpoch.current;
      const saving = Promise.resolve()
        .then(() => runtime.services.reader.saveBookTocSettings(target, settings))
        .then(
          async () => {
            failedSettings.current = null;
            await refreshDirectory(target, epoch);
          },
          (failure: unknown) => {
            failedSettings.current = { bookId: target, settings };
            throw failure;
          },
        )
        .finally(() => {
          if (pendingSettings.current === saving) pendingSettings.current = null;
        });
      pendingSettings.current = saving;
      return saving;
    },
    [refreshDirectory, runtime, sessionEpoch],
  );

  /** Selects a rule (`null` for automatic) or toggles long-chapter splitting. */
  const saveTocSettings = useCallback(
    async (settings: BookTocSettings) => {
      if (!bookId || pendingSettings.current) return;
      const epoch = sessionEpoch.current;
      setBusy(true);
      clearError();
      try {
        await writeSettings(bookId, settings);
      } catch (failure) {
        if (epoch === sessionEpoch.current)
          fail(`目录设置保存失败：${String(failure)}`, () => saveTocSettings(settings));
      } finally {
        if (epoch === sessionEpoch.current) setBusy(false);
      }
    },
    [bookId, clearError, fail, sessionEpoch, writeSettings],
  );

  const flushDirectory = useCallback(async () => {
    if (pendingSettings.current) {
      await pendingSettings.current;
      return;
    }
    const failed = failedSettings.current;
    if (failed) {
      await writeSettings(failed.bookId, failed.settings);
      clearError();
    }
  }, [clearError, writeSettings]);

  /** Runs a rule table change, then refreshes the table and the directory. */
  const changeRules = useCallback(
    async <T>(change: () => Promise<T>): Promise<T | undefined> => {
      if (!bookId) return undefined;
      const epoch = sessionEpoch.current;
      setBusy(true);
      try {
        const result = await change();
        const table = await runtime.services.reader.listTxtTocRules();
        if (epoch !== sessionEpoch.current) return result;
        setRules(table);
        await refreshDirectory(bookId, epoch);
        return result;
      } finally {
        if (epoch === sessionEpoch.current) setBusy(false);
      }
    },
    [bookId, refreshDirectory, runtime.services.reader, sessionEpoch],
  );

  const reader = runtime.services.reader;
  return {
    loading,
    error,
    reload,
    toc: listing.entries,
    tocRuleId: listing.ruleId,
    tocRuleName: listing.ruleName,
    tocSettings: listing.settings,
    rules,
    busy,
    bookmarks,
    setBookmarks,
    encodingInfo,
    setEncodingInfo,
    savingSettings: () => pendingSettings.current !== null,
    saveTocSettings,
    flushDirectory,
    saveRule: (rule: TxtTocRule) => changeRules(() => reader.saveTxtTocRule(rule)),
    deleteRule: (id: string) => changeRules(() => reader.deleteTxtTocRule(id)),
    orderRules: (ids: string[]) => changeRules(() => reader.orderTxtTocRules(ids)),
    importRules: (json: string) => changeRules(() => reader.importTxtTocRules(json)),
    exportRules: () => reader.exportTxtTocRules(),
    testRule: (pattern: string, sample: string) => reader.testTxtTocRule(pattern, sample),
  };
}

export type ReaderTools = ReturnType<typeof useReaderTools>;

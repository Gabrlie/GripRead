import { useCallback, useEffect, useRef, useState } from "react";
import type { AppRuntime } from "../../application/runtime";
import type { LibraryBook } from "../../types/generated";
import type { Bookmark, TocEntry, TxtEncodingInfo, TxtTocRule } from "../../types/generated";
import type { ReaderActions } from "./use-reader-actions";

const AUTOMATIC_RULE: TxtTocRule = { mode: "automatic", pattern: "" };

/**
 * Per-book reader tools: directory, directory rules, bookmarks, and encoding
 * information. Rule previews are cancellable; accepted rule saves complete
 * independently of the panel and participate in reader exit flushing.
 */
export function useReaderTools(
  activeBook: LibraryBook | null,
  runtime: AppRuntime,
  actions: ReaderActions,
  directoryPanelOpen: () => boolean,
) {
  const { sessionEpoch, fail, clearError } = actions;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [encodingInfo, setEncodingInfo] = useState<TxtEncodingInfo | null>(null);
  const [tocRule, setTocRule] = useState<TxtTocRule>(AUTOMATIC_RULE);
  const [ruleDraft, setRuleDraftValue] = useState<TxtTocRule>(AUTOMATIC_RULE);
  const [rulePreview, setRulePreview] = useState<TocEntry[] | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  const ruleRequest = useRef(0);
  const ruleOperation = useRef<"preview" | "save" | null>(null);
  const pendingRuleSave = useRef<Promise<TxtTocRule> | null>(null);
  const failedRuleSave = useRef<{ bookId: string; rule: TxtTocRule } | null>(null);
  const bookId = activeBook?.book.id;

  /** Invalidate a pending preview without cancelling an accepted save. */
  const cancelPreview = useCallback(() => {
    if (ruleOperation.current !== "preview") return;
    ruleRequest.current += 1;
    ruleOperation.current = null;
    setRuleBusy(false);
  }, []);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    ruleRequest.current += 1;
    ruleOperation.current = null;
    setRuleBusy(false);
    setRuleDraftValue(AUTOMATIC_RULE);
    setRulePreview(null);
    setRuleError(null);
    setLoading(true);
    setError(null);
    void Promise.all([
      runtime.services.library.getTxtEncoding(bookId),
      runtime.services.reader.listToc(bookId),
      runtime.services.reader.listBookmarks(bookId),
      runtime.services.reader.getTocRule(bookId),
    ])
      .then(([encoding, entries, saved, rule]) => {
        if (cancelled) return;
        setEncodingInfo(encoding);
        setToc(entries);
        setBookmarks(saved);
        setTocRule(rule);
        setRuleDraftValue(rule);
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
      ruleRequest.current += 1;
      setToc([]);
      setRulePreview(null);
      setRuleError(null);
      setBookmarks([]);
      setEncodingInfo(null);
    };
  }, [bookId, runtime.services, revision]);

  const saveDirectoryRule = useCallback(
    (targetBookId: string, rule: TxtTocRule) => {
      const epoch = sessionEpoch.current;
      const saving = Promise.resolve()
        .then(() => runtime.services.reader.saveTocRule({ bookId: targetBookId, rule }))
        .then(
          (saved) => {
            failedRuleSave.current = null;
            runtime.shelf.invalidateChapterCache(targetBookId);
            if (epoch === sessionEpoch.current) {
              setTocRule(saved);
              setRuleDraftValue(saved);
              setToc([]);
              setRulePreview(null);
            }
            return saved;
          },
          (failure: unknown) => {
            failedRuleSave.current = { bookId: targetBookId, rule };
            throw failure;
          },
        )
        .finally(() => {
          if (pendingRuleSave.current === saving) pendingRuleSave.current = null;
        });
      pendingRuleSave.current = saving;
      return saving;
    },
    [runtime, sessionEpoch],
  );

  const flushDirectory = useCallback(async () => {
    if (pendingRuleSave.current) {
      await pendingRuleSave.current;
      return;
    }
    const failed = failedRuleSave.current;
    if (failed) {
      await saveDirectoryRule(failed.bookId, failed.rule);
      setRuleError(null);
      clearError();
      reload();
    }
  }, [clearError, reload, saveDirectoryRule]);

  const setRuleDraft = useCallback((update: (current: TxtTocRule) => TxtTocRule) => {
    setRuleDraftValue(update);
    ruleRequest.current += 1;
    setRuleBusy(false);
    setRulePreview(null);
    setRuleError(null);
  }, []);

  const previewDirectory = useCallback(async () => {
    if (ruleOperation.current !== null || loading || error) return;
    if (!bookId || (ruleDraft.mode === "custom" && !ruleDraft.pattern.trim())) {
      setRuleError("请先填写自定义正则规则。");
      return;
    }
    const request = ++ruleRequest.current;
    const epoch = sessionEpoch.current;
    ruleOperation.current = "preview";
    setRuleBusy(true);
    setRuleError(null);
    setRulePreview(null);
    try {
      const preview = await runtime.services.reader.previewTocRule({ bookId, rule: ruleDraft });
      if (epoch === sessionEpoch.current && request === ruleRequest.current)
        setRulePreview(preview.entries);
    } catch (failure) {
      if (epoch === sessionEpoch.current && request === ruleRequest.current)
        setRuleError(String(failure));
    } finally {
      if (epoch === sessionEpoch.current && request === ruleRequest.current) {
        ruleOperation.current = null;
        setRuleBusy(false);
      }
    }
  }, [bookId, error, loading, ruleDraft, runtime.services.reader, sessionEpoch]);

  const persistDirectory = useCallback(
    async (rule: TxtTocRule) => {
      if (!bookId || ruleOperation.current !== null || loading || error) return;
      const request = ++ruleRequest.current;
      const epoch = sessionEpoch.current;
      ruleOperation.current = "save";
      setRuleBusy(true);
      setRuleError(null);
      clearError();
      let savedSuccessfully = false;
      try {
        await saveDirectoryRule(bookId, rule);
        if (epoch !== sessionEpoch.current || request !== ruleRequest.current) return;
        savedSuccessfully = true;
        const entries = await runtime.services.reader.listToc(bookId);
        if (epoch !== sessionEpoch.current || request !== ruleRequest.current) return;
        setToc(entries);
        await runtime.shelf.load(runtime.library.getSnapshot().books);
      } catch (failure) {
        if (epoch === sessionEpoch.current && request === ruleRequest.current) {
          if (savedSuccessfully) setError(`规则已保存，目录读取失败：${String(failure)}`);
          else {
            setRuleError(String(failure));
            if (!directoryPanelOpen()) {
              fail(`目录规则保存失败：${String(failure)}`, () => persistDirectory(rule));
            }
          }
        }
      } finally {
        if (epoch === sessionEpoch.current && request === ruleRequest.current) {
          ruleOperation.current = null;
          setRuleBusy(false);
        }
      }
    },
    [
      bookId,
      clearError,
      fail,
      directoryPanelOpen,
      error,
      loading,
      runtime,
      saveDirectoryRule,
      sessionEpoch,
    ],
  );

  const applyDirectory = useCallback(() => {
    if (rulePreview !== null) void persistDirectory(ruleDraft);
  }, [persistDirectory, ruleDraft, rulePreview]);

  const restoreDefaultDirectory = useCallback(() => {
    setRuleDraftValue(AUTOMATIC_RULE);
    setRulePreview(null);
    void persistDirectory(AUTOMATIC_RULE);
  }, [persistDirectory]);

  /** Stop previews before an encoding change replaces the text. */
  const resetForDecode = useCallback(() => {
    ruleRequest.current += 1;
    ruleOperation.current = null;
    setRuleBusy(false);
    setRulePreview(null);
  }, []);

  return {
    loading,
    error,
    reload,
    toc,
    bookmarks,
    setBookmarks,
    encodingInfo,
    setEncodingInfo,
    tocRule,
    ruleDraft,
    setRuleDraft,
    rulePreview,
    ruleError,
    ruleBusy,
    ruleOperation,
    cancelPreview,
    previewDirectory,
    applyDirectory,
    restoreDefaultDirectory,
    flushDirectory,
    resetForDecode,
  };
}

export type ReaderTools = ReturnType<typeof useReaderTools>;

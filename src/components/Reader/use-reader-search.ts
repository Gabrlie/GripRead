import { useCallback, useEffect, useRef, useState } from "react";
import type { ReaderService } from "../../services/contracts";
import type { SearchMatch } from "../../types/generated";

function isCancellationError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code === "import_cancelled";
  }
  return error instanceof Error && error.message.includes("search was cancelled");
}

function newSearchOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `search-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const PAGE_SIZE = 50;

/** Cancellable, paged full-text search for one open book. */
export function useReaderSearch(
  bookId: string | undefined,
  service: ReaderService,
  run: (action: () => Promise<void>) => void,
) {
  const [query, setQueryValue] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null);
  const request = useRef(0);
  const operation = useRef<string | null>(null);

  const cancel = useCallback(() => {
    request.current += 1;
    if (operation.current) {
      void service.cancelSearch(operation.current).catch(() => undefined);
      operation.current = null;
    }
    setSearching(false);
  }, [service]);

  const clearResults = useCallback(() => {
    cancel();
    setComplete(false);
    setError(null);
    setSearching(false);
    setMatches([]);
    setCursor(null);
    setHasMore(false);
    setHighlight(null);
  }, [cancel]);

  useEffect(() => clearResults, [bookId, clearResults]);

  const setQuery = useCallback(
    (value: string) => {
      clearResults();
      setQueryValue(value);
    },
    [clearResults],
  );

  const execute = useCallback(
    (from: number | null) => {
      if (!bookId || !query.trim()) return;
      const requestId = ++request.current;
      const operationId = newSearchOperationId();
      if (operation.current) {
        void service.cancelSearch(operation.current).catch(() => undefined);
      }
      operation.current = operationId;
      setComplete(false);
      setError(null);
      setSearching(true);
      run(async () => {
        try {
          const result = await service.search({
            bookId,
            query,
            caseSensitive: true,
            cursor: from,
            limit: PAGE_SIZE,
            operationId,
          });
          if (requestId === request.current) {
            setMatches((current) =>
              from === null ? result.matches : [...current, ...result.matches],
            );
            setCursor(result.nextCursor);
            setHasMore(result.hasMore);
            setComplete(true);
          }
        } catch (failure) {
          if (requestId === request.current && !isCancellationError(failure))
            setError(String(failure));
        } finally {
          if (requestId === request.current) {
            setSearching(false);
            if (operation.current === operationId) operation.current = null;
          }
        }
      });
    },
    [bookId, query, run, service],
  );

  const search = useCallback(() => {
    if (!bookId || !query.trim()) return;
    setMatches([]);
    setCursor(null);
    setHasMore(false);
    setHighlight(null);
    execute(null);
  }, [bookId, execute, query]);

  const loadMore = useCallback(() => {
    if (!hasMore || cursor === null || searching) return;
    execute(cursor);
  }, [cursor, execute, hasMore, searching]);

  return {
    query,
    setQuery,
    matches,
    hasMore,
    complete,
    error,
    searching,
    highlight,
    setHighlight,
    search,
    loadMore,
    cancel,
    clearResults,
  };
}

export type ReaderSearch = ReturnType<typeof useReaderSearch>;

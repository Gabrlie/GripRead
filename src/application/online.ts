import { useEffect, useState } from "react";
import type { SourceService } from "../services/contracts";
import type {
  ExploreKind,
  LibraryBook,
  OnlineBook,
  OnlineSearchEvent,
  OnlineSearchResult,
  OnlineTocEvent,
  SearchScope,
} from "../types/generated";

const HISTORY_KEY = "gripread.onlineSearchHistory";
const HISTORY_LIMIT = 20;

/** Search keywords on this device, newest first. */
export function readSearchHistory(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function rememberSearch(keyword: string): string[] {
  const history = [keyword, ...readSearchHistory().filter((item) => item !== keyword)].slice(
    0,
    HISTORY_LIMIT,
  );
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // History is a convenience; searching works without it.
  }
  return history;
}

export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/** How a search scope reads in the scope chip. */
export function describeScope(scope: SearchScope, sourceName?: string): string {
  if (scope.sourceUrls.length === 1) return sourceName ?? "单个书源";
  if (scope.sourceUrls.length > 1) return `${scope.sourceUrls.length} 个书源`;
  if (scope.groups.length) return scope.groups.join("、");
  return "全部书源";
}

export const ALL_SOURCES: SearchScope = { groups: [], sourceUrls: [] };

const covers = new Map<string, Promise<string | null>>();

/**
 * A cover image fetched through the source (its headers, cookies, and
 * referrer rules), as an object URL kept for the session; `null` while
 * loading or when the cover cannot be fetched.
 */
export function useOnlineCover(
  service: SourceService,
  sourceUrl: string,
  url: string | null | undefined,
  visible = true,
): string | null {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    setImage(null);
    if (!url || !sourceUrl || !visible) return;
    const key = `${sourceUrl}\n${url}`;
    let pending = covers.get(key);
    if (!pending) {
      pending = service.cover(sourceUrl, url).then(
        (bytes) => URL.createObjectURL(new Blob([bytes])),
        () => {
          // A failure is not kept here: the device cache decides when to retry.
          covers.delete(key);
          return null;
        },
      );
      covers.set(key, pending);
    }
    let active = true;
    void pending.then((value) => active && setImage(value));
    return () => {
      active = false;
    };
  }, [service, sourceUrl, url, visible]);
  return image;
}

/**
 * Runs 更新目录 for these books (every updatable shelf book when empty) and
 * resolves with each book's outcome once the update finishes.
 */
export async function updateOnlineToc(
  service: SourceService,
  bookIds: string[],
  onProgress?: (event: OnlineTocEvent) => void,
): Promise<OnlineTocEvent[]> {
  const operationId = `toc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outcomes: OnlineTocEvent[] = [];
  let stop: (() => void) | undefined;
  try {
    return await new Promise<OnlineTocEvent[]>((resolve, reject) => {
      void service
        .onTocUpdate((event) => {
          if (event.operationId !== operationId) return;
          onProgress?.(event);
          if (event.done) resolve(outcomes);
          else outcomes.push(event);
        })
        .then((unsubscribe) => {
          stop = unsubscribe;
          return service.updateToc({ operationId, bookIds });
        })
        .catch(reject);
    });
  } finally {
    stop?.();
  }
}

/** Where an online book was opened from, restored when the reader closes. */
export type OnlineReturn = {
  result: OnlineSearchResult;
  origin: number;
} & (
  | { view: "search"; scope: SearchScope; key: string; event: OnlineSearchEvent | null }
  | { view: "explore"; sourceUrl: string; sourceName: string; kind: ExploreKind }
);

/**
 * The book to keep: the details, with the search result's fields where the
 * details page left them empty (many sources give the cover only in search).
 */
export function mergeOnlineBook(found: OnlineBook, details: OnlineBook): OnlineBook {
  const pick = (key: keyof OnlineBook) => {
    const value = details[key];
    return typeof value === "string" && !value.trim() ? found[key] : value;
  };
  return Object.fromEntries(
    (Object.keys(details) as (keyof OnlineBook)[]).map((key) => [key, pick(key)]),
  ) as OnlineBook;
}

/** Saves the source's cover as a kept book's own, so the shelf never refetches it. */
export function keepOnlineCover(service: SourceService, book: LibraryBook) {
  const online = book.online;
  if (!online?.book.coverUrl || book.coverAssetId) return Promise.resolve();
  return service
    .setCoverFromSource(book.book.id, online.book.sourceUrl, online.book.coverUrl)
    .catch(() => undefined);
}

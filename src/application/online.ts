import { useEffect, useState } from "react";
import type { SourceService } from "../services/contracts";
import type { SearchScope } from "../types/generated";

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
): string | null {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    setImage(null);
    if (!url || !sourceUrl) return;
    const key = `${sourceUrl}\n${url}`;
    let pending = covers.get(key);
    if (!pending) {
      pending = service.cover(sourceUrl, url).then(
        (bytes) => URL.createObjectURL(new Blob([bytes])),
        () => null,
      );
      covers.set(key, pending);
    }
    let active = true;
    void pending.then((value) => active && setImage(value));
    return () => {
      active = false;
    };
  }, [service, sourceUrl, url]);
  return image;
}

import { useEffect, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type {
  ExploreKind,
  LibraryBook,
  OnlineBook,
  OnlineSearchResult,
} from "../../types/generated";
import type { OnlineReturn } from "../../application/online";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { OnlineBookPage } from "./OnlineBookPage";
import { SearchResultRow } from "./SearchPage";

function asResult(book: OnlineBook): OnlineSearchResult {
  return {
    name: book.name,
    author: book.author,
    kind: book.kind,
    coverUrl: book.coverUrl,
    intro: book.intro,
    wordCount: book.wordCount,
    latestChapterTitle: book.latestChapterTitle,
    origins: [book],
  };
}

/** One explore category's books, loading further pages as the list ends. */
export function ExploreListPage({
  service,
  sourceUrl,
  sourceName,
  kind,
  restored,
  onRead,
  onClose,
}: {
  service: SourceService;
  sourceUrl: string;
  sourceName: string;
  kind: ExploreKind;
  /** The book page to show again after reading. */
  restored?: { result: OnlineSearchResult; origin: number };
  onRead?: (book: LibraryBook, chapter: number | null, from: OnlineReturn) => void;
  onClose: () => void;
}) {
  const [books, setBooks] = useState<OnlineBook[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ result: OnlineSearchResult; origin: number } | null>(
    restored ?? null,
  );
  const [attempt, setAttempt] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!kind.url || ended) return;
    let active = true;
    setLoading(true);
    setError(null);
    void service.exploreBooks(sourceUrl, kind.url, page).then(
      (found) => {
        if (!active) return;
        setLoading(false);
        setBooks((current) => {
          const fresh = found.filter(
            (book) => !current.some((item) => item.bookUrl === book.bookUrl),
          );
          if (!fresh.length) setEnded(true);
          return [...current, ...fresh];
        });
      },
      (failure: unknown) => {
        if (!active) return;
        setLoading(false);
        setError(String(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [service, sourceUrl, kind.url, page, attempt]);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      // Only after a page has arrived, so the first request is not replaced.
      if (
        entries.some((entry) => entry.isIntersecting) &&
        books.length > 0 &&
        !loading &&
        !ended &&
        !error
      )
        setPage((current) => current + 1);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [loading, ended, error, books.length]);

  return (
    <FullPage label={`${sourceName} · ${kind.title}`} onClose={onClose} layer="z-[44]">
      <ul className="space-y-1.5" aria-label="书籍">
        {books.map((book) => (
          <SearchResultRow
            key={book.bookUrl}
            service={service}
            result={asResult(book)}
            onOpen={() => setOpened({ result: asResult(book), origin: 0 })}
          />
        ))}
      </ul>
      {loading && (
        <p role="status" className="py-4 text-center text-xs text-secondary">
          正在加载第 {page} 页…
        </p>
      )}
      {error && (
        <div role="alert" className="py-4 text-center space-y-2">
          <p className="text-xs text-error break-words">{error}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            重试
          </Button>
        </div>
      )}
      {ended && (
        <p className="py-4 text-center text-xs text-secondary">
          {books.length ? "没有更多了" : "这个分类没有书籍"}
        </p>
      )}
      <div ref={sentinel} className="h-4" />
      {opened && (
        <OnlineBookPage
          service={service}
          result={opened.result}
          initialOrigin={opened.origin}
          onRead={
            onRead &&
            ((book, origin, chapter) =>
              onRead(book, chapter, {
                view: "explore",
                sourceUrl,
                sourceName,
                kind,
                result: opened.result,
                origin,
              }))
          }
          onClose={() => setOpened(null)}
        />
      )}
    </FullPage>
  );
}

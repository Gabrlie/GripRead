import { useEffect, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type { OnlineBook, OnlineChapter } from "../../types/generated";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";

function absoluteUrl(chapter: OnlineChapter | undefined): string | null {
  if (!chapter) return null;
  try {
    return new URL(chapter.url, chapter.baseUrl).toString();
  } catch {
    return chapter.url;
  }
}

/**
 * A plain page that shows one chapter's text from the source, with the
 * previous and next chapters, for trying a source before online books join
 * the shelf and the reader.
 */
export function ChapterPreviewPage({
  service,
  book,
  chapters,
  index: initialIndex,
  onClose,
}: {
  service: SourceService;
  book: OnlineBook;
  chapters: OnlineChapter[];
  index: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const [text, setText] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const chapter = chapters[index];

  useEffect(() => {
    if (!chapter) return;
    let active = true;
    setText(null);
    setTitle(null);
    setError(null);
    const next = chapters.slice(index + 1).find((item) => !item.isVolume);
    void service.chapterContent(book, chapter, absoluteUrl(next)).then(
      (content) => {
        if (!active) return;
        setText(content.text);
        setTitle(content.title);
        top.current?.scrollIntoView?.({ block: "start" });
      },
      (failure: unknown) => active && setError(String(failure)),
    );
    return () => {
      active = false;
    };
  }, [service, book, chapter, attempt]);

  const step = (delta: number) => {
    let next = index + delta;
    while (chapters[next]?.isVolume) next += delta;
    if (chapters[next]) setIndex(next);
  };
  const hasPrevious = chapters.slice(0, index).some((item) => !item.isVolume);
  const hasNext = chapters.slice(index + 1).some((item) => !item.isVolume);

  return (
    <FullPage label={book.name} onClose={onClose} layer="z-[46]">
      <div ref={top} />
      <h2 className="font-title-editorial text-lg font-semibold">{title ?? chapter?.title}</h2>
      {text === null && !error && (
        <p role="status" className="text-sm text-secondary">
          正在读取正文…
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-error break-words">{error}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            <Icon name="refresh" size={14} />
            重试
          </Button>
        </div>
      )}
      {text !== null && (
        <article className="space-y-3 font-body-lg text-[17px] leading-[1.85]">
          {text.split("\n").map((paragraph, number) => (
            <p key={number} className="indent-[2em]">
              {paragraph}
            </p>
          ))}
        </article>
      )}
      <div className="flex gap-2 pt-4 pb-[calc(0.75rem+var(--safe-bottom))]">
        <Button
          variant="outline"
          className="flex-1"
          disabled={!hasPrevious}
          onClick={() => step(-1)}
        >
          上一章
        </Button>
        <Button variant="outline" className="flex-1" disabled={!hasNext} onClick={() => step(1)}>
          下一章
        </Button>
      </div>
    </FullPage>
  );
}

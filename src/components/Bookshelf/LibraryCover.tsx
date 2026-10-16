import type { LibraryBook } from "../../types/generated";
import { useRuntime } from "../../application/runtime";
import { OnlineCover } from "../Online/OnlineCover";
import { BookCover } from "./BookCover";

/**
 * A shelf book's cover: the reader's own image, else an online book's cover
 * from its source, else the generated cover.
 */
export function LibraryCover({ book, title }: { book: LibraryBook; title?: string }) {
  const runtime = useRuntime();
  const name = title ?? book.book.title;
  const online = book.online;
  if (!book.coverAssetId && online?.book.coverUrl)
    return (
      <OnlineCover
        service={runtime.services.sources}
        sourceUrl={online.book.sourceUrl}
        url={online.book.coverUrl}
        title={name}
        author={book.book.author}
      />
    );
  return <BookCover title={name} author={book.book.author} assetId={book.coverAssetId} />;
}

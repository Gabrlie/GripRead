import { t } from "../../i18n";

/** Marks a comic among search results, on the shelf, and on its details. */
export function ComicMark({ onCover = false }: { onCover?: boolean }) {
  return (
    <span
      className={
        onCover
          ? "absolute left-1 bottom-1 rounded bg-black/55 text-white text-[10px] px-1 leading-4"
          : "shrink-0 rounded-full bg-tertiary/15 text-tertiary text-[10px] px-1.5 leading-4"
      }
    >
      {t("comic.badge")}
    </span>
  );
}

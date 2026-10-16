import { t } from "../../i18n";
import { Icon } from "../ui/Icon";
import type { useTitleTranslation } from "./use-title-translation";

/** 翻译 / 显示原文 for a list's titles, styled like the list's other chips. */
export function TitleTranslationChip({
  titles,
}: {
  titles: ReturnType<typeof useTitleTranslation>;
}) {
  return (
    <button
      type="button"
      aria-pressed={titles.on}
      onClick={titles.toggle}
      className={`h-7 px-3 rounded-full text-xs inline-flex items-center gap-1 ${
        titles.on ? "bg-primary text-on-primary" : "bg-surface-container-low text-secondary"
      }`}
    >
      <Icon name="translate" size={13} />
      {titles.on
        ? titles.busy
          ? t("translation.titles.busy")
          : t("translation.titles.original")
        : t("translation.titles.translate")}
    </button>
  );
}

/** The small 译 that marks a title or introduction shown translated. */
export function TranslatedMark() {
  return (
    <span
      title={t("translation.mark.title")}
      aria-label={t("translation.mark.title")}
      className="shrink-0 rounded px-1 text-[10px] leading-4 bg-primary/10 text-primary"
    >
      {t("translation.mark")}
    </span>
  );
}

import { useFeeds } from "../../application/runtime";
import { useT } from "../../i18n";
import type { RssSettings } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { Choice, IntervalChoice, Toggle } from "./controls";

/** Days of articles kept, as the core accepts them. */
export const KEEP_DAYS = [30, 90, 180, 365];
/** The newest articles kept per feed; 0 keeps them all. */
export const KEEP_ARTICLES = [200, 500, 1000, 2000, 0];

export function keepDayLabel(days: number, t: ReturnType<typeof useT>) {
  return days === 365 ? t("rss.settings.year") : t("rss.settings.days", { count: days });
}

export function keepArticleLabel(count: number, t: ReturnType<typeof useT>) {
  return count === 0 ? t("rss.settings.unlimited") : t("rss.settings.articles", { count });
}

/**
 * 订阅设置 (设置 › 订阅, or 订阅's menu): refreshing, reading articles, and
 * how many articles are kept. Kept on this device; a feed's own settings
 * (订阅详情) go before these.
 */
export function RssSettingsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const settings = state.settings;
  const save = (change: Partial<RssSettings>) =>
    settings &&
    void store
      .saveSettings({ ...settings, ...change })
      .catch((error: unknown) => toast({ text: describeError(error), error: true }));
  return (
    <FullPage label={t("rss.settings")} onClose={onClose}>
      {settings ? (
        <>
          <PageSection title={t("rss.settings.refresh")}>
            <IntervalChoice
              label={t("rss.settings.interval")}
              note={t("rss.settings.interval.note")}
              value={settings.refreshMinutes}
              onPick={(refreshMinutes) => save({ refreshMinutes: refreshMinutes ?? 0 })}
            />
            <Toggle
              label={t("rss.settings.onEnter")}
              note={t("rss.settings.onEnter.note")}
              checked={settings.refreshOnEnter}
              onChange={(refreshOnEnter) => save({ refreshOnEnter })}
            />
          </PageSection>
          <PageSection title={t("rss.settings.reading")}>
            <Toggle
              label={t("rss.settings.markRead")}
              checked={settings.markReadOnOpen}
              onChange={(markReadOnOpen) => save({ markReadOnOpen })}
            />
            <Toggle
              label={t("rss.settings.markReadOnScroll")}
              note={t("rss.settings.markReadOnScroll.note")}
              checked={settings.markReadOnScroll}
              onChange={(markReadOnScroll) => save({ markReadOnScroll })}
            />
            <Toggle
              label={t("rss.settings.autoFull")}
              note={t("rss.settings.autoFull.note")}
              checked={settings.autoFullText}
              onChange={(autoFullText) => save({ autoFullText })}
            />
            <Toggle
              label={t("rss.settings.listImages")}
              checked={settings.listImages}
              onChange={(listImages) => save({ listImages })}
            />
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              {t("rss.settings.fontSize")}
              <span className="flex items-center gap-2">
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={t("rss.settings.smaller")}
                  disabled={settings.fontSize <= 12}
                  onClick={() => save({ fontSize: settings.fontSize - 1 })}
                >
                  <Icon name="remove" size={14} />
                </Button>
                <span className="w-6 text-center tabular-nums">{settings.fontSize}</span>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={t("rss.settings.larger")}
                  disabled={settings.fontSize >= 32}
                  onClick={() => save({ fontSize: settings.fontSize + 1 })}
                >
                  <Icon name="add" size={14} />
                </Button>
              </span>
            </div>
          </PageSection>
          <PageSection title={t("rss.settings.storage")}>
            <Choice
              label={t("rss.settings.keepArticles")}
              note={t("rss.settings.keepArticles.note")}
              options={KEEP_ARTICLES.map((count) => [count, keepArticleLabel(count, t)])}
              value={settings.keepArticles}
              onPick={(keepArticles) => save({ keepArticles })}
            />
            <Choice
              label={t("rss.settings.keep")}
              note={t("rss.settings.keep.note")}
              options={KEEP_DAYS.map((days) => [days, keepDayLabel(days, t)])}
              value={settings.keepDays}
              onPick={(keepDays) => save({ keepDays })}
            />
          </PageSection>
        </>
      ) : (
        <p role="status" className="px-1 text-sm text-secondary">
          {t("common.loading")}
        </p>
      )}
    </FullPage>
  );
}

import { useFeeds, useSettings } from "../../application/runtime";
import { useT } from "../../i18n";
import type { RssSettings } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { refreshIntervals } from "./format";

/** Days of articles kept, as the core accepts them. */
const KEEP_DAYS = [30, 90, 180, 365];

function Toggle({
  label,
  note,
  checked,
  onChange,
}: {
  label: string;
  note?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <span className="min-w-0">
        {label}
        {note && <span className="block text-[11px] text-secondary">{note}</span>}
      </span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function Choice({
  label,
  note,
  options,
  value,
  onPick,
}: {
  label: string;
  note?: string;
  options: [number, string][];
  value: number;
  onPick: (value: number) => void;
}) {
  return (
    <div className="px-4 py-3 space-y-2">
      <span className="block text-sm">
        {label}
        {note && <span className="block text-[11px] text-secondary">{note}</span>}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid gap-1 bg-surface-container p-1 rounded-lg"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            onClick={() => onPick(option)}
            className={`h-7 rounded-md text-[11px] ${
              value === option
                ? "bg-surface text-primary font-semibold shadow-sm"
                : "text-secondary"
            }`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 订阅设置 (设置 › 订阅, or 订阅's menu): refreshing, reading articles, how
 * long articles are kept, and whether 订阅 shows in the tab bar. Kept on
 * this device.
 */
export function RssSettingsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const preferences = useSettings();
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
            <Choice
              label={t("rss.settings.interval")}
              note={t("rss.settings.interval.note")}
              options={refreshIntervals([0, 30, 60, 180, 360])}
              value={settings.refreshMinutes}
              onPick={(refreshMinutes) => save({ refreshMinutes })}
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
              label={t("rss.settings.keep")}
              note={t("rss.settings.keep.note")}
              options={KEEP_DAYS.map((days) => [
                days,
                days === 365 ? t("rss.settings.year") : t("rss.settings.days", { count: days }),
              ])}
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
      {preferences.state.value && (
        <PageSection>
          <Toggle
            label={t("appearance.showSubscription")}
            note={t("rss.settings.tab.note")}
            checked={preferences.state.value.showSubscription ?? true}
            onChange={(showSubscription) => preferences.store.set({ showSubscription })}
          />
        </PageSection>
      )}
    </FullPage>
  );
}

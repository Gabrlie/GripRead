import { useEffect, useState } from "react";
import { useFeeds } from "../../application/runtime";
import { useT } from "../../i18n";
import type { Feed, FeedOptions } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import { Choice, GroupField, IntervalChoice, Toggle } from "./controls";
import { appliesTo, FilterList } from "./FeedFiltersPage";
import { articleTime } from "./format";
import { KEEP_ARTICLES, KEEP_DAYS, keepArticleLabel, keepDayLabel } from "./RssSettingsPage";

function Field({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block px-4 py-3 space-y-1.5">
      <span className="block text-sm">{label}</span>
      {children}
      {note && <span className="block text-[11px] text-secondary">{note}</span>}
    </label>
  );
}

/**
 * 订阅详情: a feed's name, group, and address; whether and how often it is
 * refreshed; reading its articles; how many are kept; the 过滤规则 that
 * apply to it; and unsubscribing.
 * Changes are saved together; each setting may follow 订阅设置.
 */
function FeedDetail({ feed, onClose, layer }: { feed: Feed; onClose: () => void; layer: string }) {
  const t = useT();
  const { state, store } = useFeeds();
  const [title, setTitle] = useState(feed.title);
  const [group, setGroup] = useState(feed.group ?? "");
  const [url, setUrl] = useState(feed.url);
  const [enabled, setEnabled] = useState(feed.enabled);
  const [options, setOptions] = useState<FeedOptions>(feed.options);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const groups = state.groups.map((item) => item.name);
  useEffect(() => {
    void store.loadFilters().catch(() => undefined);
  }, [store]);
  const change = (patch: Partial<FeedOptions>) =>
    setOptions((current) => ({ ...current, ...patch }));
  const save = () => {
    setSaving(true);
    setError(null);
    void store
      .updateFeed({
        url: feed.url,
        title: title.trim(),
        group: group.trim() || null,
        newUrl: url.trim() === feed.url ? null : url.trim(),
        enabled,
        options,
      })
      .then(
        () => {
          toast(t("rss.saved"));
          onClose();
        },
        (failure: unknown) => setError(describeError(failure)),
      )
      .finally(() => setSaving(false));
  };
  const follow = t("rss.settings.follow");
  return (
    <FullPage
      label={t("rss.feed.settings")}
      onClose={onClose}
      layer={layer}
      actions={
        <Button size="sm" disabled={saving || !title.trim() || !url.trim()} onClick={save}>
          {saving ? t("rss.feed.saving") : t("common.save")}
        </Button>
      }
    >
      {error && (
        <p role="alert" className="px-1 text-xs text-error break-all">
          {error}
        </p>
      )}
      <PageSection title={t("rss.feed.basic")}>
        <Field label={t("rss.name")}>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label={t("rss.group")}>
          <GroupField id="rss-feed-groups" value={group} onChange={setGroup} groups={groups} />
        </Field>
        <Field label={t("rss.address")} note={t("rss.feed.url.note")}>
          <Input
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="break-all"
          />
        </Field>
      </PageSection>
      <PageSection title={t("rss.feed.update")}>
        <Toggle
          label={t("rss.feed.enabled")}
          note={t("rss.feed.enabled.note")}
          checked={enabled}
          onChange={setEnabled}
        />
        {enabled && (
          <IntervalChoice
            follow
            label={t("rss.feed.interval")}
            value={options.refreshMinutes}
            onPick={(refreshMinutes) => change({ refreshMinutes })}
          />
        )}
      </PageSection>
      <PageSection title={t("rss.settings.reading")}>
        <Choice<boolean | null>
          label={t("rss.feed.fullText")}
          options={[
            [null, follow],
            [true, t("rss.settings.on")],
            [false, t("rss.settings.off")],
          ]}
          value={options.fullText}
          onPick={(fullText) => change({ fullText })}
        />
        <Toggle
          label={t("rss.feed.viaServer")}
          note={t("rss.feed.viaServer.note")}
          checked={options.viaServer}
          onChange={(viaServer) => change({ viaServer })}
        />
      </PageSection>
      <PageSection title={t("rss.feed.storage")}>
        <Choice<number | null>
          label={t("rss.settings.keepArticles")}
          options={[
            [null, follow],
            ...KEEP_ARTICLES.map((count): [number, string] => [count, keepArticleLabel(count, t)]),
          ]}
          value={options.keepArticles}
          onPick={(keepArticles) => change({ keepArticles })}
        />
        <Choice<number | null>
          label={t("rss.feed.keepDays")}
          options={[
            [null, follow],
            ...KEEP_DAYS.map((days): [number, string] => [days, keepDayLabel(days, t)]),
          ]}
          value={options.keepDays}
          onPick={(keepDays) => change({ keepDays })}
        />
        <Choice<boolean | null>
          label={t("rss.feed.keepUnread")}
          options={[
            [null, follow],
            [true, t("rss.settings.on")],
            [false, t("rss.settings.off")],
          ]}
          value={options.keepUnread}
          onPick={(keepUnread) => change({ keepUnread })}
        />
      </PageSection>
      <PageSection title={t("rss.filters.forFeed")}>
        <FilterList
          filters={state.filters.filter((filter) => appliesTo(filter, feed))}
          preset={{ scope: "feed", target: feed.url }}
        />
      </PageSection>
      <PageSection title={t("rss.feed.status")}>
        <p className="px-4 py-3 text-xs text-secondary space-y-1">
          <span className="block">
            {t("rss.feed.counts", { total: feed.total, unread: feed.unread })}
          </span>
          <span className={`block break-all ${feed.lastError ? "text-error" : ""}`}>
            {feed.lastError
              ? t("rss.failedWith", { error: feed.lastError })
              : feed.lastFetch
                ? t("rss.refreshedAt", { time: articleTime(feed.lastFetch), count: feed.total })
                : t("rss.neverRefreshed")}
          </span>
        </p>
      </PageSection>
      <PageSection>
        <button
          type="button"
          className="w-full px-4 py-3 text-left text-sm text-error"
          onClick={() => setRemoving(true)}
        >
          {t("rss.unsubscribe")}
        </button>
      </PageSection>
      {removing && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(false)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("rss.unsubscribe")}
              </DialogTitle>
              <DialogDescription>
                {t("rss.unsubscribe.confirm", { title: feed.title })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRemoving(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                className="bg-error text-on-error"
                onClick={() =>
                  void store.removeFeeds([feed.url]).then(
                    () => {
                      toast(t("rss.unsubscribed"));
                      onClose();
                    },
                    (failure: unknown) => toast({ text: describeError(failure), error: true }),
                  )
                }
              >
                {t("common.confirm")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </FullPage>
  );
}

/** 订阅详情 of the feed at `url`, while it is subscribed. */
export function FeedDetailPage({
  url,
  onClose,
  layer = "z-50",
}: {
  url: string;
  onClose: () => void;
  layer?: string;
}) {
  const { state } = useFeeds();
  const feed = state.feeds.find((item) => item.url === url);
  if (!feed) return null;
  return <FeedDetail key={feed.url} feed={feed} onClose={onClose} layer={layer} />;
}

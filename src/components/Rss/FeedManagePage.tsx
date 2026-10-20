import { useState } from "react";
import { useFeeds } from "../../application/runtime";
import { describeError } from "../Cloud/format";
import { FullPage, PageLink, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { AddFeedDialog } from "./AddFeedDialog";
import { FeedDetailPage } from "./FeedDetailPage";
import { FeedGroupsDialog } from "./FeedGroupsDialog";
import { articleTime } from "./format";
import { useT } from "../../i18n";

/**
 * 管理订阅: adding feeds, 分组管理, each feed with its last refresh or error
 * (refresh one, or open its 订阅详情), and OPML import and export.
 */
export function FeedManagePage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const [detail, setDetail] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [grouping, setGrouping] = useState(false);
  return (
    <FullPage
      label={t("rss.manage")}
      onClose={onClose}
      actions={
        <Button
          size="sm"
          variant="outline"
          className="flex items-center gap-1 bg-surface-container text-primary h-8 px-2.5 rounded-lg border-transparent"
          onClick={() => setAdding(true)}
        >
          <Icon name="add" size={16} />
          <span className="text-xs">{t("rss.add")}</span>
        </Button>
      }
    >
      <PageSection>
        <PageLink
          icon="folder"
          label={t("rss.groups")}
          detail={t("rss.groups.note")}
          onClick={() => setGrouping(true)}
        />
      </PageSection>
      <PageSection title={t("rss.feeds", { count: state.feeds.length })}>
        {state.feeds.length === 0 && (
          <p className="px-4 py-3 text-sm text-secondary">{t("rss.noFeeds")}</p>
        )}
        {state.feeds.map((feed) => (
          <div key={feed.url} className="flex items-center gap-2 pl-4 pr-2 py-1">
            <button
              type="button"
              aria-label={t("rss.feed.open", { title: feed.title })}
              className="flex-1 min-w-0 py-1.5 text-left"
              onClick={() => setDetail(feed.url)}
            >
              <span className={`block text-sm truncate ${feed.enabled ? "" : "text-secondary"}`}>
                {feed.title}
              </span>
              <span
                className={`block text-[11px] truncate ${feed.lastError ? "text-error" : "text-secondary"}`}
              >
                {feed.group ? `${feed.group} · ` : ""}
                {!feed.enabled
                  ? t("rss.feed.stopped")
                  : feed.lastError
                    ? t("rss.failedWith", { error: feed.lastError })
                    : feed.lastFetch
                      ? t("rss.refreshedAt", {
                          time: articleTime(feed.lastFetch),
                          count: feed.total,
                        })
                      : t("rss.neverRefreshed")}
              </span>
            </button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("rss.refreshOne", { title: feed.title })}
              disabled={state.refreshing !== null || !feed.enabled}
              onClick={() => void store.refresh([feed.url])}
            >
              <Icon name="refresh" size={16} />
            </Button>
            <Icon name="chevron_right" size={16} className="text-outline-variant shrink-0" />
          </div>
        ))}
      </PageSection>
      <PageSection title={t("rss.opml")}>
        <div className="flex gap-2 p-4">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void store.importOpml().then(
                (report) =>
                  report &&
                  toast(
                    report.existing
                      ? t("rss.importedExisting", report)
                      : t("rss.imported", { added: report.added }),
                  ),
                (error: unknown) => toast({ text: describeError(error), error: true }),
              )
            }
          >
            <Icon name="upload" size={15} />
            {t("rss.importOpml")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={state.feeds.length === 0}
            onClick={() =>
              void store.exportOpml().then(
                (saved) => saved && toast(t("rss.opmlSaved")),
                (error: unknown) => toast({ text: describeError(error), error: true }),
              )
            }
          >
            <Icon name="download" size={15} />
            {t("rss.exportOpml")}
          </Button>
        </div>
      </PageSection>
      {detail && <FeedDetailPage url={detail} onClose={() => setDetail(null)} />}
      {adding && <AddFeedDialog onClose={() => setAdding(false)} />}
      {grouping && <FeedGroupsDialog onClose={() => setGrouping(false)} />}
    </FullPage>
  );
}

import { useState } from "react";
import { useFeeds } from "../../application/runtime";
import { FullPage, PageLink, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { reportError, toast } from "../ui/toast";
import { FeedSearchPage } from "./FeedSearchPage";
import { accountStatus, FeedAccountsPage } from "./FeedAccountsPage";
import { FeedDetailPage } from "./FeedDetailPage";
import { FeedGroupsPage } from "./FeedGroupsPage";
import { feedStatus } from "./FeedList";
import { feedGroups } from "../../application/rss";
import { useT } from "../../i18n";

/**
 * 管理订阅: adding feeds, 分组管理, 订阅账号, the device's own feeds and
 * then each account's, by group, each with its last update or error
 * (refresh one, or open its 订阅详情), and OPML import and export.
 */
export function FeedManagePage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const [detail, setDetail] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [accounts, setAccounts] = useState(false);
  const local = state.feeds.filter((feed) => feed.account === null);
  // The device's own feeds, then each account's, each by group.
  const sides = [
    ...(local.length
      ? [{ id: null, title: t("rss.feeds.local", { count: local.length }), feeds: local }]
      : []),
    ...state.accounts.map((account) => ({
      id: account.id,
      title: `${account.name} · ${accountStatus(account, t)}`,
      feeds: state.feeds.filter((feed) => feed.account === account.id),
    })),
  ];
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
          detail={t("rss.groups.short")}
          onClick={() => setGrouping(true)}
        />
        <PageLink
          icon="cloud"
          label={t("rss.accounts")}
          detail={
            state.accounts.length
              ? state.accounts.map((account) => account.name).join("、")
              : t("rss.accounts.short")
          }
          onClick={() => setAccounts(true)}
        />
      </PageSection>
      {state.feeds.length === 0 && (
        <PageSection title={t("rss.feeds", { count: 0 })}>
          <p className="px-4 py-3 text-sm text-secondary">{t("rss.noFeeds")}</p>
        </PageSection>
      )}
      {sides.map((side) => (
        <PageSection key={side.id ?? ""} title={side.title}>
          {feedGroups(side.feeds, side.id === null ? state.groups : []).map((group) => (
            <div key={group.name ?? ""}>
              <p className="px-4 pt-2.5 pb-0.5 text-[11px] font-medium text-secondary">
                {group.name ?? t("rss.feed.noGroup")}
              </p>
              {group.feeds.map((feed) => {
                const status = feedStatus(feed, state.accounts, t);
                return (
                  <div key={feed.url} className="flex items-center gap-2 pl-4 pr-2 py-1">
                    <button
                      type="button"
                      aria-label={t("rss.feed.open", { title: feed.title })}
                      className="flex-1 min-w-0 py-1.5 text-left"
                      onClick={() => setDetail(feed.url)}
                    >
                      <span
                        className={`block text-sm truncate ${feed.enabled ? "" : "text-secondary"}`}
                      >
                        {feed.title}
                      </span>
                      <span
                        className={`block text-[11px] truncate ${status.failed ? "text-error" : "text-secondary"}`}
                      >
                        {`${status.text} · ${t("rss.articleCount", { count: feed.total })}`}
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
                    <Icon
                      name="chevron_right"
                      size={16}
                      className="text-outline-variant shrink-0"
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </PageSection>
      ))}
      <PageSection title={t("rss.opml")}>
        <div className="flex gap-2 p-4">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void store
                .importOpml()
                .then(
                  (report) =>
                    report &&
                    toast(
                      report.existing
                        ? t("rss.importedExisting", report)
                        : t("rss.imported", { added: report.added }),
                    ),
                  reportError,
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
              void store
                .exportOpml()
                .then((saved) => saved && toast(t("rss.opmlSaved")), reportError)
            }
          >
            <Icon name="download" size={15} />
            {t("rss.exportOpml")}
          </Button>
        </div>
      </PageSection>
      {detail && <FeedDetailPage url={detail} onClose={() => setDetail(null)} />}
      {adding && <FeedSearchPage onClose={() => setAdding(false)} />}
      {grouping && <FeedGroupsPage onClose={() => setGrouping(false)} />}
      {accounts && <FeedAccountsPage onClose={() => setAccounts(false)} />}
    </FullPage>
  );
}

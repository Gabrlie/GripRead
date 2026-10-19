import { useState } from "react";
import { useFeeds } from "../../application/runtime";
import type { Feed } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageLink, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import { articleTime } from "./format";
import { RssSettingsPage } from "./RssSettingsPage";
import { useT } from "../../i18n";

function EditFeedDialog({ feed, onClose }: { feed: Feed; onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const [title, setTitle] = useState(feed.title);
  const [group, setGroup] = useState(feed.group ?? "");
  const [removing, setRemoving] = useState(false);
  const groups = [...new Set(state.feeds.map((item) => item.group).filter(Boolean))] as string[];
  const run = (work: () => Promise<unknown>, done: string) =>
    void work().then(
      () => {
        toast(done);
        onClose();
      },
      (error: unknown) => toast({ text: describeError(error), error: true }),
    );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {removing ? t("rss.unsubscribe") : t("rss.edit")}
          </DialogTitle>
          <DialogDescription className="break-all">
            {removing ? t("rss.unsubscribe.confirm", { title: feed.title }) : feed.url}
          </DialogDescription>
        </DialogHeader>
        {!removing && (
          <div className="space-y-2">
            <Input
              aria-label={t("rss.name")}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Input
              aria-label={t("rss.group")}
              placeholder={t("rss.group.placeholder")}
              list="rss-edit-groups"
              value={group}
              onChange={(event) => setGroup(event.target.value)}
            />
            <datalist id="rss-edit-groups">
              {groups.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
        )}
        <div className="flex items-center gap-2">
          {!removing && (
            <Button
              variant="ghost"
              size="sm"
              className="text-error"
              onClick={() => setRemoving(true)}
            >
              {t("rss.unsubscribe")}
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={removing ? () => setRemoving(false) : onClose}>
            {removing ? t("common.back") : t("common.cancel")}
          </Button>
          {removing ? (
            <Button
              size="sm"
              className="bg-error text-on-error"
              onClick={() => run(() => store.removeFeeds([feed.url]), t("rss.unsubscribed"))}
            >
              {t("common.confirm")}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!title.trim()}
              onClick={() =>
                run(
                  () => store.updateFeed(feed.url, title.trim(), group.trim() || null),
                  t("rss.saved"),
                )
              }
            >
              {t("common.save")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 管理订阅: each feed with its last refresh or error (edit, refresh one,
 * unsubscribe), OPML import and export, and a way to 订阅设置.
 */
export function FeedManagePage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const [editing, setEditing] = useState<Feed | null>(null);
  const [setting, setSetting] = useState(false);
  return (
    <FullPage label={t("rss.manage")} onClose={onClose}>
      <PageSection title={t("rss.feeds", { count: state.feeds.length })}>
        {state.feeds.length === 0 && (
          <p className="px-4 py-3 text-sm text-secondary">{t("rss.noFeeds")}</p>
        )}
        {state.feeds.map((feed) => (
          <div key={feed.url} className="flex items-center gap-2 px-4 py-2.5">
            <span className="flex-1 min-w-0">
              <span className="block text-sm truncate">{feed.title}</span>
              <span
                className={`block text-[11px] truncate ${feed.lastError ? "text-error" : "text-secondary"}`}
              >
                {feed.group ? `${feed.group} · ` : ""}
                {feed.lastError
                  ? t("rss.failedWith", { error: feed.lastError })
                  : feed.lastFetch
                    ? t("rss.refreshedAt", { time: articleTime(feed.lastFetch), count: feed.total })
                    : t("rss.neverRefreshed")}
              </span>
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("rss.refreshOne", { title: feed.title })}
              disabled={state.refreshing !== null}
              onClick={() => void store.refresh([feed.url])}
            >
              <Icon name="refresh" size={16} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("rss.editOne", { title: feed.title })}
              onClick={() => setEditing(feed)}
            >
              <Icon name="edit" size={16} />
            </Button>
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
      <PageSection>
        <PageLink
          icon="settings"
          label={t("rss.settings")}
          detail={t("rss.settings.note")}
          onClick={() => setSetting(true)}
        />
      </PageSection>
      {editing && <EditFeedDialog feed={editing} onClose={() => setEditing(null)} />}
      {setting && <RssSettingsPage onClose={() => setSetting(false)} />}
    </FullPage>
  );
}

import { useState } from "react";
import { useFeeds } from "../../application/runtime";
import type { Feed, RssSettings } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { articleTime } from "./format";

const INTERVALS: [number, string][] = [
  [0, "关闭"],
  [30, "30 分钟"],
  [60, "1 小时"],
  [180, "3 小时"],
  [360, "6 小时"],
];

function EditFeedDialog({ feed, onClose }: { feed: Feed; onClose: () => void }) {
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
            {removing ? "取消订阅" : "编辑订阅"}
          </DialogTitle>
          <DialogDescription className="break-all">
            {removing ? `取消订阅「${feed.title}」？星标文章会保留。` : feed.url}
          </DialogDescription>
        </DialogHeader>
        {!removing && (
          <div className="space-y-2">
            <Input
              aria-label="名称"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Input
              aria-label="分组"
              placeholder="分组（可选）"
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
              取消订阅
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={removing ? () => setRemoving(false) : onClose}>
            {removing ? "返回" : "取消"}
          </Button>
          {removing ? (
            <Button
              size="sm"
              className="bg-error text-on-error"
              onClick={() => run(() => store.removeFeeds([feed.url]), "已取消订阅")}
            >
              确定
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!title.trim()}
              onClick={() =>
                run(() => store.updateFeed(feed.url, title.trim(), group.trim() || null), "已保存")
              }
            >
              保存
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 管理订阅: each feed with its last refresh or error (edit, refresh one,
 * unsubscribe), OPML import and export, and 订阅's settings.
 */
export function FeedManagePage({ onClose }: { onClose: () => void }) {
  const { state, store } = useFeeds();
  const [editing, setEditing] = useState<Feed | null>(null);
  const settings = state.settings;
  const save = (change: Partial<RssSettings>) =>
    settings &&
    void store
      .saveSettings({ ...settings, ...change })
      .catch((error: unknown) => toast({ text: describeError(error), error: true }));
  return (
    <FullPage label="管理订阅" onClose={onClose}>
      <PageSection title={`订阅（${state.feeds.length}）`}>
        {state.feeds.length === 0 && (
          <p className="px-4 py-3 text-sm text-secondary">还没有订阅。</p>
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
                  ? `刷新失败：${feed.lastError}`
                  : feed.lastFetch
                    ? `${articleTime(feed.lastFetch)}刷新 · ${feed.total} 篇`
                    : "尚未刷新"}
              </span>
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`刷新 ${feed.title}`}
              disabled={state.refreshing !== null}
              onClick={() => void store.refresh([feed.url])}
            >
              <Icon name="refresh" size={16} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`编辑 ${feed.title}`}
              onClick={() => setEditing(feed)}
            >
              <Icon name="edit" size={16} />
            </Button>
          </div>
        ))}
      </PageSection>
      <PageSection title="导入与导出">
        <div className="flex gap-2 p-4">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void store.importOpml().then(
                (report) =>
                  report &&
                  toast(
                    `导入 ${report.added} 个订阅${report.existing ? `，${report.existing} 个已存在` : ""}`,
                  ),
                (error: unknown) => toast({ text: describeError(error), error: true }),
              )
            }
          >
            <Icon name="upload" size={15} />
            导入 OPML
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={state.feeds.length === 0}
            onClick={() =>
              void store.exportOpml().then(
                (saved) => saved && toast("OPML 已保存"),
                (error: unknown) => toast({ text: describeError(error), error: true }),
              )
            }
          >
            <Icon name="download" size={15} />
            导出 OPML
          </Button>
        </div>
      </PageSection>
      {settings && (
        <PageSection title="设置">
          <div className="px-4 py-3 space-y-2">
            <span className="text-sm">
              自动刷新
              <span className="block text-[11px] text-secondary">应用打开时按间隔刷新全部订阅</span>
            </span>
            <div
              role="radiogroup"
              aria-label="自动刷新"
              className="grid grid-cols-5 gap-1 bg-surface-container p-1 rounded-lg"
            >
              {INTERVALS.map(([minutes, label]) => (
                <button
                  key={minutes}
                  type="button"
                  role="radio"
                  aria-checked={settings.refreshMinutes === minutes}
                  onClick={() => save({ refreshMinutes: minutes })}
                  className={`h-7 rounded-md text-[11px] ${
                    settings.refreshMinutes === minutes
                      ? "bg-surface text-primary font-semibold shadow-sm"
                      : "text-secondary"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            打开文章时标为已读
            <Switch
              aria-label="打开文章时标为已读"
              checked={settings.markReadOnOpen}
              onCheckedChange={(markReadOnOpen) => save({ markReadOnOpen })}
            />
          </label>
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            正文字号
            <span className="flex items-center gap-2">
              <Button
                size="icon"
                variant="outline"
                aria-label="缩小字号"
                disabled={settings.fontSize <= 12}
                onClick={() => save({ fontSize: settings.fontSize - 1 })}
              >
                <Icon name="remove" size={14} />
              </Button>
              <span className="w-6 text-center tabular-nums">{settings.fontSize}</span>
              <Button
                size="icon"
                variant="outline"
                aria-label="放大字号"
                disabled={settings.fontSize >= 32}
                onClick={() => save({ fontSize: settings.fontSize + 1 })}
              >
                <Icon name="add" size={14} />
              </Button>
            </span>
          </div>
        </PageSection>
      )}
      {editing && <EditFeedDialog feed={editing} onClose={() => setEditing(null)} />}
    </FullPage>
  );
}

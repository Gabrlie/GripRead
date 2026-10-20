import { useState } from "react";
import { feedGroups, type FeedSelection } from "../../application/rss";
import type { Feed, FeedAccount, FeedGroup } from "../../types/generated";
import { Icon } from "../ui/Icon";
import { useLongPress } from "../ui/use-long-press";
import { useT } from "../../i18n";

/** Unread counts above this show as "999+". */
const MAX_COUNT = 999;

export function Count({ value }: { value: number }) {
  return value > 0 ? (
    <span className="text-[11px] tabular-nums text-secondary shrink-0">
      {value > MAX_COUNT ? `${MAX_COUNT}+` : value}
    </span>
  ) : null;
}

function FeedRow({
  feed,
  active,
  nested,
  onSelect,
  onDetail,
}: {
  feed: Feed;
  active: boolean;
  nested: boolean;
  onSelect: () => void;
  onDetail?: () => void;
}) {
  const t = useT();
  const press = useLongPress(() => onDetail?.(), onSelect);
  return (
    <li>
      <button
        type="button"
        aria-current={active || undefined}
        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm ${
          active ? "bg-surface-container text-primary font-medium" : "text-on-surface"
        } ${nested ? "pl-8" : ""} ${feed.enabled ? "" : "opacity-55"}`}
        {...press}
      >
        <Icon name="rss_feed" size={15} className="text-secondary shrink-0" />
        <span className="flex-1 min-w-0 truncate">{feed.title}</span>
        {feed.lastError && feed.enabled && (
          <Icon
            name="error"
            size={14}
            className="text-error shrink-0"
            aria-label={t("rss.feedFailed")}
          />
        )}
        <Count value={feed.unread} />
      </button>
    </li>
  );
}

function same(left: FeedSelection, right: FeedSelection): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "group" && right.kind === "group")
    return left.group === right.group && (left.account ?? null) === (right.account ?? null);
  if (left.kind === "feed" && right.kind === "feed") return left.url === right.url;
  if (left.kind === "account" && right.kind === "account") return left.account === right.account;
  return true;
}

/**
 * 全部文章, then the device's own groups in their order (folding) with
 * their feeds, then each 订阅账号 with its groups and feeds; unread counts
 * beside. A long press on a feed opens its 订阅详情.
 */
export function FeedList({
  feeds,
  groups = [],
  accounts = [],
  selection,
  onSelect,
  onDetail,
}: {
  feeds: Feed[];
  groups?: FeedGroup[];
  accounts?: FeedAccount[];
  selection: FeedSelection;
  onSelect: (selection: FeedSelection) => void;
  onDetail?: (url: string) => void;
}) {
  const t = useT();
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const total = feeds.reduce((sum, feed) => sum + feed.unread, 0);
  const row = (active: boolean) =>
    `flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm ${
      active ? "bg-surface-container text-primary font-medium" : "text-on-surface"
    }`;
  const fold = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const feedRow = (feed: Feed, nested: boolean) => {
    const target: FeedSelection = { kind: "feed", url: feed.url };
    return (
      <FeedRow
        key={feed.url}
        feed={feed}
        nested={nested}
        active={same(selection, target)}
        onSelect={() => onSelect(target)}
        onDetail={onDetail && (() => onDetail(feed.url))}
      />
    );
  };
  /** Groups (folding) and the feeds outside them. */
  const sections = (own: Feed[], order: FeedGroup[], account: string | null) =>
    feedGroups(own, order).map((group) => {
      if (group.name === null) return group.feeds.map((feed) => feedRow(feed, false));
      const name = group.name;
      const key = `${account ?? ""}/${name}`;
      const target: FeedSelection = { kind: "group", group: name, account };
      return (
        <li key={`group:${key}`}>
          <div className="flex items-center">
            <button
              type="button"
              aria-label={t(folded.has(key) ? "rss.expand" : "rss.collapse", { group: name })}
              className="h-8 w-7 flex items-center justify-center text-secondary"
              onClick={() => fold(key)}
            >
              <Icon name="expand_more" size={16} className={folded.has(key) ? "-rotate-90" : ""} />
            </button>
            <button
              type="button"
              aria-current={same(selection, target) || undefined}
              className={`${row(same(selection, target))} pl-1`}
              onClick={() => onSelect(target)}
            >
              <Icon name="folder" size={15} className="text-secondary shrink-0" />
              <span className="flex-1 min-w-0 truncate">{name}</span>
              <Count value={group.unread} />
            </button>
          </div>
          {!folded.has(key) && (
            <ul className="space-y-0.5">{group.feeds.map((feed) => feedRow(feed, true))}</ul>
          )}
        </li>
      );
    });
  return (
    <nav aria-label={t("rss.feedList")} className="space-y-1">
      <button
        type="button"
        aria-current={selection.kind === "all" || undefined}
        className={row(selection.kind === "all")}
        onClick={() => onSelect({ kind: "all" })}
      >
        <Icon name="all_inbox" size={16} className="shrink-0" />
        <span className="flex-1">{t("rss.allArticles")}</span>
        <Count value={total} />
      </button>
      <ul className="space-y-0.5">
        {sections(
          feeds.filter((feed) => feed.account === null),
          groups,
          null,
        )}
      </ul>
      {accounts.map((account) => {
        const own = feeds.filter((feed) => feed.account === account.id);
        const target: FeedSelection = { kind: "account", account: account.id };
        const key = `account:${account.id}`;
        return (
          <section key={account.id} aria-label={account.name} className="pt-2 space-y-0.5">
            <div className="flex items-center">
              <button
                type="button"
                aria-label={t(folded.has(key) ? "rss.expand" : "rss.collapse", {
                  group: account.name,
                })}
                className="h-8 w-7 flex items-center justify-center text-secondary"
                onClick={() => fold(key)}
              >
                <Icon
                  name="expand_more"
                  size={16}
                  className={folded.has(key) ? "-rotate-90" : ""}
                />
              </button>
              <button
                type="button"
                aria-current={same(selection, target) || undefined}
                className={`${row(same(selection, target))} pl-1`}
                onClick={() => onSelect(target)}
              >
                <Icon name="cloud" size={15} className="text-secondary shrink-0" />
                <span className="flex-1 min-w-0 truncate">{account.name}</span>
                {account.lastError && (
                  <Icon
                    name="error"
                    size={14}
                    className="text-error shrink-0"
                    aria-label={t("rss.account.failed")}
                  />
                )}
                <Count value={own.reduce((sum, feed) => sum + feed.unread, 0)} />
              </button>
            </div>
            {!folded.has(key) && (
              <ul className="space-y-0.5 pl-3">{sections(own, [], account.id)}</ul>
            )}
          </section>
        );
      })}
    </nav>
  );
}

import { useState } from "react";
import { feedGroups, type FeedSelection } from "../../application/rss";
import type { Feed } from "../../types/generated";
import { Icon } from "../ui/Icon";

function Count({ value }: { value: number }) {
  return value > 0 ? (
    <span className="text-[11px] tabular-nums text-secondary shrink-0">{value}</span>
  ) : null;
}

function same(left: FeedSelection, right: FeedSelection): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "group" && right.kind === "group") return left.group === right.group;
  if (left.kind === "feed" && right.kind === "feed") return left.url === right.url;
  return true;
}

/** 全部文章, then the groups (folding) with their feeds, unread counts beside. */
export function FeedList({
  feeds,
  selection,
  onSelect,
}: {
  feeds: Feed[];
  selection: FeedSelection;
  onSelect: (selection: FeedSelection) => void;
}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const total = feeds.reduce((sum, feed) => sum + feed.unread, 0);
  const row = (active: boolean) =>
    `flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm ${
      active ? "bg-surface-container text-primary font-medium" : "text-on-surface"
    }`;
  const feedRow = (feed: Feed, nested: boolean) => {
    const target: FeedSelection = { kind: "feed", url: feed.url };
    return (
      <li key={feed.url}>
        <button
          type="button"
          aria-current={same(selection, target) || undefined}
          className={`${row(same(selection, target))} ${nested ? "pl-8" : ""}`}
          onClick={() => onSelect(target)}
        >
          <Icon name="rss_feed" size={15} className="text-secondary shrink-0" />
          <span className="flex-1 min-w-0 truncate">{feed.title}</span>
          {feed.lastError && (
            <Icon name="error" size={14} className="text-error shrink-0" aria-label="刷新失败" />
          )}
          <Count value={feed.unread} />
        </button>
      </li>
    );
  };
  return (
    <nav aria-label="订阅列表" className="space-y-1">
      <button
        type="button"
        aria-current={selection.kind === "all" || undefined}
        className={row(selection.kind === "all")}
        onClick={() => onSelect({ kind: "all" })}
      >
        <Icon name="all_inbox" size={16} className="shrink-0" />
        <span className="flex-1">全部文章</span>
        <Count value={total} />
      </button>
      <ul className="space-y-0.5">
        {feedGroups(feeds).map((group) =>
          group.name === null ? (
            group.feeds.map((feed) => feedRow(feed, false))
          ) : (
            <li key={`group:${group.name}`}>
              <div className="flex items-center">
                <button
                  type="button"
                  aria-label={folded.has(group.name) ? `展开 ${group.name}` : `收起 ${group.name}`}
                  className="h-8 w-7 flex items-center justify-center text-secondary"
                  onClick={() =>
                    setFolded((current) => {
                      const next = new Set(current);
                      if (next.has(group.name!)) next.delete(group.name!);
                      else next.add(group.name!);
                      return next;
                    })
                  }
                >
                  <Icon
                    name="expand_more"
                    size={16}
                    className={folded.has(group.name) ? "-rotate-90" : ""}
                  />
                </button>
                <button
                  type="button"
                  aria-current={same(selection, { kind: "group", group: group.name }) || undefined}
                  className={`${row(same(selection, { kind: "group", group: group.name }))} pl-1`}
                  onClick={() => onSelect({ kind: "group", group: group.name! })}
                >
                  <Icon name="folder" size={15} className="text-secondary shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{group.name}</span>
                  <Count value={group.unread} />
                </button>
              </div>
              {!folded.has(group.name) && (
                <ul className="space-y-0.5">{group.feeds.map((feed) => feedRow(feed, true))}</ul>
              )}
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

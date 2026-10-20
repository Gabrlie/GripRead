import { useState } from "react";
import { feedGroups, type FeedSelection } from "../../application/rss";
import type { Feed, FeedGroup } from "../../types/generated";
import { Icon } from "../ui/Icon";
import { useLongPress } from "../ui/use-long-press";
import { useT } from "../../i18n";

function Count({ value }: { value: number }) {
  return value > 0 ? (
    <span className="text-[11px] tabular-nums text-secondary shrink-0">{value}</span>
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
  if (left.kind === "group" && right.kind === "group") return left.group === right.group;
  if (left.kind === "feed" && right.kind === "feed") return left.url === right.url;
  return true;
}

/**
 * 全部文章, then the groups in their order (folding) with their feeds,
 * unread counts beside. A long press on a feed opens its 订阅详情.
 */
export function FeedList({
  feeds,
  groups = [],
  selection,
  onSelect,
  onDetail,
}: {
  feeds: Feed[];
  groups?: FeedGroup[];
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
        {feedGroups(feeds, groups).map((group) =>
          group.name === null ? (
            group.feeds.map((feed) => feedRow(feed, false))
          ) : (
            <li key={`group:${group.name}`}>
              <div className="flex items-center">
                <button
                  type="button"
                  aria-label={t(folded.has(group.name) ? "rss.expand" : "rss.collapse", {
                    group: group.name,
                  })}
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

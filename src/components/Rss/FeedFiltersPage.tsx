import { useEffect, useState } from "react";
import { useFeeds } from "../../application/runtime";
import { useT } from "../../i18n";
import type { Feed, FeedFilter } from "../../types/generated";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { Switch } from "../ui/switch";
import { reportError } from "../ui/toast";
import { FILTER_FIELDS, FilterDialog, newFilter } from "./FilterDialog";

/**
 * Whether a rule applies to the feed: all feeds, its group (one of the
 * device's own), or itself.
 */
export function appliesTo(filter: FeedFilter, feed: Feed) {
  return (
    filter.scope === "all" ||
    (filter.scope === "group" && feed.account === null && filter.target === feed.group) ||
    (filter.scope === "feed" && filter.target === feed.url)
  );
}

/**
 * Rules as rows (what they match, where, and how) with a switch each; a
 * row opens the rule, and the last row adds one (`preset` for it).
 */
export function FilterList({
  filters,
  preset,
}: {
  filters: FeedFilter[];
  preset?: Partial<FeedFilter>;
}) {
  const t = useT();
  const { state, store } = useFeeds();
  const [editing, setEditing] = useState<FeedFilter | null>(null);
  const scopeLabel = (filter: FeedFilter) =>
    filter.scope === "all"
      ? t("rss.filter.scope.all")
      : filter.scope === "group"
        ? t("rss.filter.scope.groupName", { group: filter.target ?? "" })
        : t("rss.filter.scope.feedName", {
            feed:
              state.feeds.find((feed) => feed.url === filter.target)?.title ?? filter.target ?? "",
          });
  const field = (filter: FeedFilter) =>
    t(FILTER_FIELDS.find(([value]) => value === filter.field)![1]);
  return (
    <>
      {filters.map((filter) => (
        <div key={filter.id} className="flex items-center gap-2 pl-4 pr-3 py-1">
          <button
            type="button"
            className="flex-1 min-w-0 py-1.5 text-left"
            onClick={() => setEditing(filter)}
          >
            <span
              className={`block text-sm font-mono truncate ${filter.enabled ? "" : "text-secondary line-through"}`}
            >
              {filter.pattern}
            </span>
            <span className="block text-[11px] text-secondary truncate">
              <span className={filter.mode === "keep" ? "text-primary" : "text-error"}>
                {filter.mode === "keep" ? t("rss.filter.keep") : t("rss.filter.drop")}
              </span>
              {` · ${field(filter)} · ${scopeLabel(filter)}`}
            </span>
          </button>
          <Switch
            aria-label={t("rss.filter.toggle", { pattern: filter.pattern })}
            checked={filter.enabled}
            onCheckedChange={(enabled) =>
              void store.saveFilter({ ...filter, enabled }, false).catch(reportError)
            }
          />
        </div>
      ))}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-3 text-left text-sm text-primary"
        onClick={() => setEditing(newFilter(preset))}
      >
        <Icon name="add" size={16} />
        {t("rss.filters.add")}
      </button>
      {editing && <FilterDialog filter={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** 过滤规则 (订阅设置): every rule, for all feeds, a group, or a feed. */
export function FeedFiltersPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void store.loadFilters().catch(reportError);
  }, [store]);
  return (
    <FullPage
      label={t("rss.filters")}
      onClose={onClose}
      layer="z-50"
      actions={
        <Button
          size="sm"
          variant="outline"
          className="flex items-center gap-1 bg-surface-container text-primary h-8 px-2.5 rounded-lg border-transparent"
          onClick={() => setAdding(true)}
        >
          <Icon name="add" size={16} />
          <span className="text-xs">{t("rss.filters.add")}</span>
        </Button>
      }
    >
      <p className="px-1 text-xs text-secondary">{t("rss.filters.only")}</p>
      <PageSection
        title={
          state.filters.length ? t("rss.filters.count", { count: state.filters.length }) : undefined
        }
      >
        {state.filters.length === 0 && (
          <p className="px-4 py-3 text-sm text-secondary">{t("rss.filters.empty")}</p>
        )}
        <FilterList filters={state.filters} />
      </PageSection>
      {adding && <FilterDialog filter={newFilter()} onClose={() => setAdding(false)} />}
    </FullPage>
  );
}

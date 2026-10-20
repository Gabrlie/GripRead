import { useState } from "react";
import { useFeeds, useRuntime } from "../../application/runtime";
import { useT, type MessageKey } from "../../i18n";
import type {
  FeedFilter,
  FeedFilterField,
  FeedFilterMode,
  FeedFilterScope,
  FeedFilterTest,
} from "../../types/generated";
import { describeError } from "../Cloud/format";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import { Choice, Toggle } from "./controls";

export const FILTER_FIELDS: [FeedFilterField, MessageKey][] = [
  ["title", "rss.filter.field.title"],
  ["author", "rss.filter.field.author"],
  ["content", "rss.filter.field.content"],
  ["any", "rss.filter.field.any"],
];

const MODES: [FeedFilterMode, MessageKey][] = [
  ["drop", "rss.filter.mode.drop"],
  ["keep", "rss.filter.mode.keep"],
];

const SCOPES: [FeedFilterScope, MessageKey][] = [
  ["all", "rss.filter.scope.all"],
  ["group", "rss.filter.scope.group"],
  ["feed", "rss.filter.scope.feed"],
];

/** A new rule: dropping titles that match, for all feeds unless `scope` says. */
export function newFilter(scope: Partial<FeedFilter> = {}): FeedFilter {
  return {
    id: "",
    scope: "all",
    target: null,
    field: "title",
    mode: "drop",
    pattern: "",
    ignoreCase: true,
    enabled: true,
    sort: 0,
    ...scope,
  };
}

/**
 * A 过滤规则 being made or changed: its expression, what it matches, whether
 * it drops or keeps, which feeds it applies to, a test on the stored
 * articles, and removing the stored ones it would have kept out.
 */
export function FilterDialog({ filter, onClose }: { filter: FeedFilter; onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const service = useRuntime().services.feeds;
  const [rule, setRule] = useState(filter);
  const [purge, setPurge] = useState(false);
  const [test, setTest] = useState<FeedFilterTest | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = state.groups.map((group) => group.name);
  const change = (patch: Partial<FeedFilter>) => {
    setRule((current) => ({ ...current, ...patch }));
    setTest(null);
    setError(null);
  };
  const ready = rule.pattern.trim() !== "" && (rule.scope === "all" || Boolean(rule.target));
  const run = (kind: "test" | "save") => {
    setBusy(kind);
    setError(null);
    const work =
      kind === "test"
        ? service.testFilter(rule).then(setTest)
        : store.saveFilter(rule, purge).then(() => {
            toast(t("rss.filter.saved"));
            onClose();
          });
    void work
      .catch((failure: unknown) => setError(describeError(failure)))
      .finally(() => setBusy(null));
  };
  const remove = () =>
    void store.removeFilter(rule.id).then(
      () => {
        toast(t("rss.filter.removed"));
        onClose();
      },
      (failure: unknown) => setError(describeError(failure)),
    );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md p-5 gap-3 max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {rule.id ? t("rss.filter.edit") : t("rss.filter.new")}
          </DialogTitle>
          <DialogDescription>{t("rss.filters.only")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) run("save");
          }}
        >
          <label className="block px-4 py-2 space-y-1.5">
            <span className="block text-sm">{t("rss.filter.pattern")}</span>
            <Input
              autoFocus={!rule.id}
              aria-label={t("rss.filter.pattern")}
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              value={rule.pattern}
              onChange={(event) => change({ pattern: event.target.value })}
            />
            <span className="block text-[11px] text-secondary">{t("rss.filter.pattern.note")}</span>
          </label>
          <Choice
            label={t("rss.filter.field")}
            options={FILTER_FIELDS.map(([field, key]) => [field, t(key)])}
            value={rule.field}
            onPick={(field) => change({ field })}
          />
          <Choice
            label={t("rss.filter.mode")}
            options={MODES.map(([mode, key]) => [mode, t(key)])}
            value={rule.mode}
            onPick={(mode) => change({ mode })}
          />
          <Choice
            label={t("rss.filter.scope")}
            options={SCOPES.map(([scope, key]) => [scope, t(key)])}
            value={rule.scope}
            onPick={(scope) =>
              change({
                scope,
                target:
                  scope === "group"
                    ? (groups[0] ?? null)
                    : scope === "feed"
                      ? (state.feeds[0]?.url ?? null)
                      : null,
              })
            }
          />
          {rule.scope !== "all" && (
            <div className="px-4 pb-2">
              <select
                aria-label={
                  rule.scope === "group" ? t("rss.filter.chooseGroup") : t("rss.filter.chooseFeed")
                }
                value={rule.target ?? ""}
                onChange={(event) => change({ target: event.target.value || null })}
                className="w-full h-9 rounded-lg bg-surface-container px-2 text-sm text-on-surface"
              >
                {rule.scope === "group"
                  ? groups.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))
                  : state.feeds.map((feed) => (
                      <option key={feed.url} value={feed.url}>
                        {feed.title}
                      </option>
                    ))}
              </select>
            </div>
          )}
          <Toggle
            label={t("rss.filter.ignoreCase")}
            checked={rule.ignoreCase}
            onChange={(ignoreCase) => change({ ignoreCase })}
          />
          {rule.id && (
            <Toggle
              label={t("rss.filter.enabled")}
              checked={rule.enabled}
              onChange={(enabled) => change({ enabled })}
            />
          )}
          <Toggle
            label={t("rss.filter.purge")}
            note={t("rss.filter.purge.note")}
            checked={purge}
            onChange={setPurge}
          />
          <div className="px-4 py-2 space-y-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!ready || busy !== null}
              onClick={() => run("test")}
            >
              {busy === "test" ? t("rss.filter.testing") : t("rss.filter.test")}
            </Button>
            {test && (
              <div role="status" className="text-xs text-secondary space-y-1">
                <p>{t("rss.filter.tested", { checked: test.checked, dropped: test.dropped })}</p>
                {test.samples.length > 0 && (
                  <ul className="list-disc pl-4 space-y-0.5">
                    {test.samples.map((title, index) => (
                      <li key={index} className="truncate">
                        {title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          {error && (
            <p role="alert" className="px-4 text-xs text-error break-all">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2 pt-2">
            {rule.id && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-error"
                onClick={remove}
              >
                {t("rss.filter.remove")}
              </Button>
            )}
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={!ready || busy !== null}>
              {busy === "save" ? t("rss.feed.saving") : t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

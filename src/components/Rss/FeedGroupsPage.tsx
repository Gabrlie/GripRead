import { useState } from "react";
import { feedGroupNames } from "../../application/rss";
import { useFeeds } from "../../application/runtime";
import { useT } from "../../i18n";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { reportError, toast } from "../ui/toast";
import { Toggle } from "./controls";

/** A group of the device's own feeds (`account` null) or of an account's. */
export interface GroupRef {
  group: string;
  account: string | null;
}

/** Asks for a group name: a new group's, or a group's new one. */
function NameForm({
  initial = "",
  label,
  taken,
  onSubmit,
}: {
  initial?: string;
  label: string;
  taken: string[];
  onSubmit: (name: string) => Promise<unknown> | void;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const value = name.trim();
  return (
    <form
      className="flex gap-2 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void Promise.resolve(onSubmit(value))
          .then(() => !initial && setName(""), reportError)
          .finally(() => setBusy(false));
      }}
    >
      <Input
        aria-label={t("rss.groups.newName")}
        placeholder={t("rss.groups.newName")}
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="h-8 text-xs"
      />
      <Button
        type="submit"
        size="sm"
        disabled={busy || !value || value === initial || taken.includes(value)}
        className="h-8 text-xs shrink-0"
      >
        {label}
      </Button>
    </form>
  );
}

/**
 * A group's page: renaming it, which feeds are in it (a switch each, the
 * feeds of its own side only), refreshing it, and removing it (its feeds
 * ungrouped, or unsubscribed too). An account's group changes on the
 * account.
 */
export function FeedGroupPage({
  group,
  account,
  onClose,
  onRenamed,
  layer = "z-[55]",
}: GroupRef & { onClose: () => void; onRenamed?: (name: string) => void; layer?: string }) {
  const t = useT();
  const { state, store } = useFeeds();
  const [name, setName] = useState(group);
  const [moving, setMoving] = useState<string | null>(null);
  const [removing, setRemoving] = useState<"keep" | "all" | null>(null);
  const side = state.feeds.filter((feed) => feed.account === account);
  const members = side.filter((feed) => feed.group === name);
  const owner = account ? state.accounts.find((item) => item.id === account) : undefined;
  const move = (url: string, into: boolean) => {
    const feed = side.find((item) => item.url === url)!;
    setMoving(url);
    void store
      .updateFeed({
        url,
        title: feed.title,
        group: into ? name : null,
        newUrl: null,
        enabled: null,
        options: null,
      })
      .catch(reportError)
      .finally(() => setMoving(null));
  };
  const remove = (unsubscribe: boolean) =>
    void store.removeGroup(name, unsubscribe, account).then(() => {
      toast(t("rss.groups.removed"));
      onClose();
    }, reportError);
  return (
    <FullPage
      label={name}
      onClose={onClose}
      layer={layer}
      actions={
        <Button
          size="sm"
          variant="outline"
          className="flex items-center gap-1 bg-surface-container text-primary h-8 px-2.5 rounded-lg border-transparent"
          disabled={state.refreshing !== null || members.length === 0}
          onClick={() =>
            void store.refresh(
              members.map((feed) => feed.url),
              false,
            )
          }
        >
          <Icon name="refresh" size={16} className={state.refreshing ? "animate-spin" : ""} />
          <span className="text-xs">{t("rss.refresh")}</span>
        </Button>
      }
    >
      {owner && (
        <p className="px-1 text-xs text-secondary">
          {t("rss.groups.onAccount", { name: owner.name })}
        </p>
      )}
      <PageSection title={t("rss.groups.rename")}>
        <NameForm
          key={name}
          initial={name}
          label={t("rss.groups.rename")}
          taken={account === null ? [] : feedGroupNames(state, account)}
          onSubmit={async (next) => {
            // Without feeds an account's group is only a name here.
            if (members.length || account === null) await store.renameGroup(name, next, account);
            setName(next);
            onRenamed?.(next);
            toast(t("rss.saved"));
          }}
        />
      </PageSection>
      <PageSection title={t("rss.groups.members", { count: members.length })}>
        {side.length === 0 && (
          <p className="px-4 py-3 text-sm text-secondary">{t("rss.noFeeds")}</p>
        )}
        {side.map((feed) => (
          <div
            key={feed.url}
            className={moving === feed.url ? "opacity-60 pointer-events-none" : ""}
          >
            <Toggle
              label={feed.title}
              note={
                feed.group && feed.group !== name
                  ? t("rss.groups.inOther", { group: feed.group })
                  : undefined
              }
              checked={feed.group === name}
              onChange={(into) => move(feed.url, into)}
            />
          </div>
        ))}
      </PageSection>
      <PageSection>
        <button
          type="button"
          className="w-full px-4 py-3 text-left text-sm text-error"
          onClick={() => setRemoving("keep")}
        >
          {t("rss.groups.remove")}
        </button>
      </PageSection>
      {removing && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("rss.groups.remove.confirm", { group: name })}
              </DialogTitle>
              <DialogDescription>
                {owner
                  ? t("rss.groups.remove.account", { name: owner.name })
                  : t("rss.groups.remove.note")}
              </DialogDescription>
            </DialogHeader>
            <div
              role="radiogroup"
              aria-label={t("rss.groups.remove")}
              className="space-y-1.5 text-xs"
            >
              {(["keep", "all"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={removing === value}
                  onClick={() => setRemoving(value)}
                  className={`w-full rounded-xl border px-3 py-2 text-left ${
                    removing === value ? "border-error bg-error/10" : "border-surface-variant/50"
                  }`}
                >
                  {t(value === "keep" ? "rss.groups.removeKeep" : "rss.groups.removeAll")}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                className="bg-error text-on-error"
                onClick={() => remove(removing === "all")}
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

/**
 * 分组管理: the device's own groups in their order (moved up and down),
 * then each 订阅账号's (by name); a group opens its page, and each side
 * takes a new group.
 */
export function FeedGroupsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const [open, setOpen] = useState<GroupRef | null>(null);
  // An account's new group, named before any feed is in it.
  const [drafts, setDrafts] = useState<GroupRef[]>([]);
  const local = state.groups.map((group) => group.name);
  const count = (ref: GroupRef) =>
    state.feeds.filter((feed) => feed.account === ref.account && feed.group === ref.group).length;
  const move = (index: number, by: number) => {
    const order = [...local];
    const [group] = order.splice(index, 1);
    order.splice(index + by, 0, group);
    void store.saveGroups(order).catch(reportError);
  };
  const row = (ref: GroupRef, index: number, names: string[]) => (
    <div key={ref.group} className="flex items-center gap-1 pr-2">
      <button
        type="button"
        className="flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left"
        onClick={() => setOpen(ref)}
      >
        <Icon name="folder" size={18} className="text-primary shrink-0" />
        <span className="flex-1 min-w-0 truncate text-sm">{ref.group}</span>
        <span className="shrink-0 text-[11px] text-secondary">
          {t("rss.groups.feeds", { count: count(ref) })}
        </span>
      </button>
      {ref.account === null && (
        <>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t("rss.groups.up", { group: ref.group })}
            disabled={index === 0}
            onClick={() => move(index, -1)}
          >
            <Icon name="arrow_upward" size={15} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t("rss.groups.down", { group: ref.group })}
            disabled={index === names.length - 1}
            onClick={() => move(index, 1)}
          >
            <Icon name="arrow_downward" size={15} />
          </Button>
        </>
      )}
      <Icon name="chevron_right" size={16} className="text-outline-variant shrink-0" />
    </div>
  );
  const accountNames = (account: string) => {
    const names = feedGroupNames(state, account).sort((left, right) => left.localeCompare(right));
    for (const draft of drafts)
      if (draft.account === account && !names.includes(draft.group)) names.push(draft.group);
    return names;
  };
  return (
    <FullPage label={t("rss.groups")} onClose={onClose} layer="z-50">
      <p className="px-1 text-xs text-secondary">{t("rss.groups.note")}</p>
      <PageSection title={state.accounts.length ? t("rss.groups.local") : undefined}>
        {local.length === 0 && (
          <p className="px-4 py-3 text-sm text-secondary">{t("rss.groups.empty")}</p>
        )}
        {local.map((group, index) => row({ group, account: null }, index, local))}
        <NameForm
          label={t("rss.groups.add")}
          taken={local}
          onSubmit={async (name) => {
            await store.saveGroups([...local, name]);
            setOpen({ group: name, account: null });
          }}
        />
      </PageSection>
      {state.accounts.map((account) => {
        const names = accountNames(account.id);
        return (
          <PageSection key={account.id} title={account.name}>
            {names.length === 0 && (
              <p className="px-4 py-3 text-sm text-secondary">{t("rss.groups.empty")}</p>
            )}
            {names.map((group, index) => row({ group, account: account.id }, index, names))}
            <NameForm
              label={t("rss.groups.add")}
              taken={names}
              onSubmit={(name) => {
                const ref = { group: name, account: account.id };
                setDrafts((current) => [...current, ref]);
                setOpen(ref);
              }}
            />
          </PageSection>
        );
      })}
      {open && (
        <FeedGroupPage
          {...open}
          onClose={() => setOpen(null)}
          onRenamed={(name) => {
            setDrafts((current) =>
              current.map((draft) =>
                draft.account === open.account && draft.group === open.group
                  ? { ...draft, group: name }
                  : draft,
              ),
            );
            setOpen({ ...open, group: name });
          }}
        />
      )}
    </FullPage>
  );
}

import { useState } from "react";
import { useFeeds } from "../../application/runtime";
import { useT, type MessageKey } from "../../i18n";
import type { FeedAccount, FeedAccountKind } from "../../types/generated";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { reportError, toast } from "../ui/toast";
import { Choice } from "./controls";
import { articleTime } from "./format";

const KINDS: [FeedAccountKind, MessageKey, string][] = [
  ["freshRss", "rss.account.kind.freshRss", "https://rss.example.com"],
  ["miniflux", "rss.account.kind.miniflux", "https://flux.example.com"],
  ["googleReader", "rss.account.kind.googleReader", "https://reader.example.com/api"],
];

const KIND_NOTES: Record<FeedAccountKind, MessageKey> = {
  freshRss: "rss.account.kind.freshRss.note",
  miniflux: "rss.account.kind.miniflux.note",
  googleReader: "rss.account.kind.googleReader.note",
};

function kindLabel(kind: FeedAccountKind, t: ReturnType<typeof useT>) {
  return t(KINDS.find(([item]) => item === kind)![1]);
}

/** How an account last synced: when, why it failed, and marks still to write. */
export function accountStatus(account: FeedAccount, t: ReturnType<typeof useT>) {
  const parts = [
    account.lastError
      ? t("rss.failedWith", { error: account.lastError })
      : account.lastSync
        ? t("rss.account.syncedAt", { time: articleTime(account.lastSync) })
        : t("rss.account.neverSynced"),
  ];
  if (account.pending) parts.push(t("rss.account.pending", { count: account.pending }));
  return parts.join(" · ");
}

function Field({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block px-4 py-3 space-y-1.5">
      <span className="block text-sm">{label}</span>
      {children}
      {note && <span className="block text-[11px] text-secondary">{note}</span>}
    </label>
  );
}

/**
 * An account being added or changed: its service, address, user name, and
 * password (signed in to before saving; kept only on this device), and
 * what 过滤规则 do with the articles they keep out. A saved account keeps
 * its address and user name; it can be synced now or removed here.
 */
export function AccountPage({
  account,
  onClose,
  layer = "z-[55]",
}: {
  account: FeedAccount | null;
  onClose: () => void;
  layer?: string;
}) {
  const t = useT();
  const { state, store } = useFeeds();
  const [kind, setKind] = useState<FeedAccountKind>(account?.kind ?? "freshRss");
  const [name, setName] = useState(account?.name ?? "");
  const [server, setServer] = useState(account?.server ?? "");
  const [username, setUsername] = useState(account?.username ?? "");
  const [password, setPassword] = useState("");
  const [filterRead, setFilterRead] = useState(account?.filterRead ?? false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The account as it is now, its last sync included.
  const current = account && (state.accounts.find((item) => item.id === account.id) ?? account);
  const ready = server.trim() !== "" && username.trim() !== "" && (account || password !== "");
  const save = () => {
    setBusy(true);
    void store
      .saveAccount({
        id: account?.id ?? null,
        kind,
        name: name.trim(),
        server: server.trim(),
        username: username.trim(),
        password: password || null,
        filterRead,
      })
      .then((saved) => {
        toast(account ? t("rss.saved") : t("rss.account.added", { name: saved.name }));
        onClose();
      }, reportError)
      .finally(() => setBusy(false));
  };
  return (
    <FullPage
      label={account ? account.name : t("rss.account.add")}
      onClose={onClose}
      layer={layer}
      actions={
        <Button size="sm" disabled={busy || !ready} onClick={save}>
          {busy ? t("rss.account.signingIn") : t("common.save")}
        </Button>
      }
    >
      <PageSection title={t("rss.account.service")}>
        <Choice<FeedAccountKind>
          label={t("rss.account.kind")}
          note={t(KIND_NOTES[kind])}
          options={KINDS.map(([item, label]): [FeedAccountKind, string] => [item, t(label)])}
          value={kind}
          onPick={setKind}
        />
        <Field label={t("rss.account.server")} note={account ? t("rss.account.fixed") : undefined}>
          <Input
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            disabled={Boolean(account)}
            placeholder={KINDS.find(([item]) => item === kind)![2]}
            value={server}
            onChange={(event) => setServer(event.target.value)}
          />
        </Field>
        <Field label={t("rss.account.username")}>
          <Input
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="username"
            disabled={Boolean(account)}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label={t("rss.account.password")} note={t("rss.account.password.note")}>
          <Input
            type="password"
            autoComplete="current-password"
            placeholder={account ? t("rss.account.password.keep") : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label={t("rss.name")}>
          <Input
            placeholder={username.trim() || t("rss.account.name.placeholder")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </PageSection>
      <PageSection title={t("rss.filters")}>
        <Choice<boolean>
          label={t("rss.account.filterRead")}
          note={t("rss.account.filterRead.note")}
          options={[
            [false, t("rss.account.filterRead.leave")],
            [true, t("rss.account.filterRead.read")],
          ]}
          value={filterRead}
          onPick={setFilterRead}
        />
      </PageSection>
      {current && (
        <>
          <PageSection title={t("rss.feed.status")}>
            <p className="px-4 py-3 text-xs text-secondary break-all">
              {t("rss.account.feeds", {
                count: state.feeds.filter((feed) => feed.account === current.id).length,
              })}
              {" · "}
              <span className={current.lastError ? "text-error" : ""}>
                {accountStatus(current, t)}
              </span>
            </p>
            <button
              type="button"
              className="w-full px-4 py-3 text-left text-sm text-primary disabled:opacity-50"
              disabled={state.refreshing !== null}
              onClick={() => void store.refresh([], false, [current.id])}
            >
              {state.refreshing ? t("rss.account.syncing") : t("rss.account.syncNow")}
            </button>
          </PageSection>
          <PageSection>
            <button
              type="button"
              className="w-full px-4 py-3 text-left text-sm text-error"
              onClick={() => setRemoving(true)}
            >
              {t("rss.account.remove")}
            </button>
          </PageSection>
        </>
      )}
      {removing && current && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(false)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("rss.account.remove")}
              </DialogTitle>
              <DialogDescription>
                {t("rss.account.remove.confirm", { name: current.name })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRemoving(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                className="bg-error text-on-error"
                onClick={() =>
                  void store.removeAccount(current.id).then(() => {
                    toast(t("rss.account.removed"));
                    onClose();
                  }, reportError)
                }
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
 * 订阅账号: Google Reader API services (FreshRSS, Miniflux, and others)
 * whose feeds 订阅 lists beside the device's own, each with its last sync;
 * adding one, or opening one to change it.
 */
export function FeedAccountsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { state } = useFeeds();
  const [open, setOpen] = useState<FeedAccount | "new" | null>(null);
  return (
    <FullPage
      label={t("rss.accounts")}
      onClose={onClose}
      layer="z-50"
      actions={
        <Button
          size="sm"
          variant="outline"
          className="flex items-center gap-1 bg-surface-container text-primary h-8 px-2.5 rounded-lg border-transparent"
          onClick={() => setOpen("new")}
        >
          <Icon name="add" size={16} />
          <span className="text-xs">{t("rss.account.add")}</span>
        </Button>
      }
    >
      <PageSection>
        {state.accounts.length === 0 && (
          <p className="px-4 py-3 text-sm text-secondary">{t("rss.accounts.empty")}</p>
        )}
        {state.accounts.map((account) => (
          <button
            key={account.id}
            type="button"
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-container transition-colors"
            onClick={() => setOpen(account)}
          >
            <Icon name="cloud" size={18} className="text-primary shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-sm truncate">{account.name}</span>
              <span className="block text-[11px] text-secondary truncate">
                {kindLabel(account.kind, t)} · {account.username}
              </span>
              <span
                className={`block text-[11px] truncate ${account.lastError ? "text-error" : "text-secondary"}`}
              >
                {accountStatus(account, t)}
              </span>
            </span>
            <Icon name="chevron_right" size={16} className="text-outline-variant shrink-0" />
          </button>
        ))}
      </PageSection>
      <p className="px-1 text-[11px] text-secondary">{t("rss.accounts.note")}</p>
      {open && <AccountPage account={open === "new" ? null : open} onClose={() => setOpen(null)} />}
    </FullPage>
  );
}

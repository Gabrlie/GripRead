import { useState } from "react";
import { useLibrary, useShelf } from "../../application/runtime";
import type { GroupLock, LibraryGroup } from "../../types/generated";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { describeError } from "../Cloud/format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/Icon";
import { t } from "../../i18n";

export function GroupManager({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, store } = useShelf();
  const { state: library } = useLibrary();
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = state.groups.find((group) => group.id === selectedId);
  const run = (action: () => Promise<void>) =>
    void action().catch(() => {
      /* Store exposes the failure and keeps the dialog open. */
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-surface border-surface-variant/50 max-w-sm w-[calc(100%-2rem)] rounded-2xl p-5 space-y-4">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base font-semibold text-on-surface text-left">
            {t("shelf.menu.groups")}
          </DialogTitle>
          <DialogDescription className="text-secondary text-xs text-left">
            {t("groups.note")}
          </DialogDescription>
        </DialogHeader>
        {state.error && (
          <p role="alert" className="text-xs text-error">
            {state.error}
          </p>
        )}
        {selected ? (
          <div className="space-y-3 text-xs">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedId(null);
                setName("");
              }}
              className="h-7 px-1"
            >
              <Icon name="arrow_back" size={14} />
              {t("groups.all")}
            </Button>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  await store.rename(selected.id, name);
                });
              }}
            >
              <Input
                aria-label={t("groups.name")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-8 text-xs bg-surface-container"
              />
              <Button
                type="submit"
                size="sm"
                disabled={state.saving || !name.trim()}
                className="h-8 text-xs"
              >
                {t("common.save")}
              </Button>
            </form>
            <p className="text-secondary">{t("groups.moveNote")}</p>
            <PrivacySettings
              key={`${selected.id}:${selected.privacy?.lock ?? ""}:${selected.privacy?.sync ?? ""}`}
              group={selected}
              onDeleted={() => {
                setSelectedId(null);
                setName("");
              }}
            />
          </div>
        ) : (
          <>
            <div className="space-y-1.5 text-xs text-left max-h-64 overflow-auto">
              {state.groups.map((group) => (
                <button
                  key={group.id}
                  onClick={() => {
                    setSelectedId(group.id);
                    setName(group.name);
                  }}
                  className="w-full flex items-center justify-between py-1.5 px-2 rounded-lg bg-surface-container"
                >
                  <span className="flex items-center gap-1.5 text-on-surface font-medium">
                    {group.privacy && (
                      <Icon name="lock" size={12} aria-label={t("groups.private")} />
                    )}
                    {group.name}
                  </span>
                  <span className="text-secondary text-[11px]">
                    {
                      group.bookIds.filter((id) =>
                        library.books.some((item) => item.book.id === id),
                      ).length
                    }{" "}
                    {t("groups.booksSuffix")} <span aria-hidden="true">›</span>
                  </span>
                </button>
              ))}
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  await store.create(name);
                  setName("");
                });
              }}
            >
              <Input
                aria-label={t("groups.newName")}
                placeholder={t("groups.newName")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-8 text-xs bg-surface-container"
              />
              <Button
                type="submit"
                size="sm"
                disabled={state.saving || !name.trim()}
                className="h-8 text-xs"
              >
                {t("downloads.add")}
              </Button>
            </form>
          </>
        )}
        <DialogFooter className="pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A group's privacy: private or not, how it opens, its password, and
 * whether its books sync; then deleting it, which a password group allows
 * only with its password.
 */
function PrivacySettings({ group, onDeleted }: { group: LibraryGroup; onDeleted: () => void }) {
  const { state, store } = useShelf();
  const [isPrivate, setPrivate] = useState(Boolean(group.privacy));
  const [lock, setLock] = useState<GroupLock>(group.privacy?.lock ?? "mask");
  const [noSync, setNoSync] = useState(group.privacy ? !group.privacy.sync : true);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasPassword = group.privacy?.lock === "password";
  const attempt = (action: () => Promise<void>, done?: string) => {
    setBusy(true);
    setError(null);
    action().then(
      () => {
        setBusy(false);
        if (done) toast(done);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(describeError(failure));
      },
    );
  };
  const field = "h-8 text-xs bg-surface-container";
  return (
    <div className="space-y-3 border-t border-surface-variant/30 pt-3">
      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="flex items-center gap-1.5 text-on-surface font-medium">
            <Icon name="lock" size={13} />
            {t("groups.private")}
          </span>
          <span className="block text-[11px] text-secondary">{t("groups.privateNote")}</span>
        </span>
        <Switch checked={isPrivate} onCheckedChange={setPrivate} />
      </label>
      {isPrivate && (
        <>
          <div role="radiogroup" aria-label={t("groups.lock")} className="grid grid-cols-2 gap-2">
            {(["mask", "password"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={lock === value}
                onClick={() => setLock(value)}
                className={`rounded-xl border px-3 py-2 text-left ${lock === value ? "border-primary bg-primary/10" : "border-surface-variant/50"}`}
              >
                <span className="block font-medium text-on-surface">
                  {t(`groups.lock.${value}`)}
                </span>
                <span className="block text-[11px] text-secondary">
                  {t(`groups.lock.${value}Note`)}
                </span>
              </button>
            ))}
          </div>
          {lock === "password" && (
            <Input
              type="password"
              autoComplete="new-password"
              aria-label={hasPassword ? t("groups.password.keep") : t("groups.password.new")}
              placeholder={hasPassword ? t("groups.password.keep") : t("groups.password.new")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={field}
            />
          )}
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-on-surface font-medium">{t("groups.noSync")}</span>
              <span className="block text-[11px] text-secondary">{t("groups.noSyncNote")}</span>
            </span>
            <Switch checked={noSync} onCheckedChange={setNoSync} />
          </label>
          {lock === "password" && (
            <p className="text-[11px] text-secondary">{t("groups.password.forgot")}</p>
          )}
        </>
      )}
      {hasPassword && (
        <Input
          type="password"
          autoComplete="current-password"
          aria-label={t("groups.password.current")}
          placeholder={t("groups.password.current")}
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          className={field}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy || state.saving}
          onClick={() =>
            attempt(
              () =>
                store.savePrivacy({
                  id: group.id,
                  privacy: isPrivate ? { lock, sync: !noSync } : undefined,
                  password: isPrivate && lock === "password" && password ? password : undefined,
                  currentPassword: hasPassword ? current : undefined,
                }),
              t("groups.privacySaved"),
            )
          }
        >
          {t("groups.savePrivacy")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-xs text-error h-7"
          disabled={busy || state.saving}
          onClick={() =>
            attempt(async () => {
              await store.remove(group.id, hasPassword ? current : undefined);
              onDeleted();
            })
          }
        >
          {t("groups.delete")}
        </Button>
      </div>
    </div>
  );
}

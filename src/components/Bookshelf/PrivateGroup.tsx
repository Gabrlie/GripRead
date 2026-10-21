import { useState, type ReactNode } from "react";
import type { LibraryGroup } from "../../types/generated";
import { useShelf } from "../../application/runtime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { t } from "../../i18n";
import { reportError } from "../ui/toast";

/**
 * A locked private group in place of its books: a blur mask over them that
 * a tap lifts, or, for a password group, only the lock (its books are not
 * drawn at all until the password is given).
 */
export function PrivateGroupLock({
  group,
  count,
  children,
}: {
  group: LibraryGroup;
  count: number;
  children: ReactNode;
}) {
  const { store } = useShelf();
  const [asking, setAsking] = useState(false);
  const password = group.privacy?.lock === "password";
  const open = () => (password ? setAsking(true) : void store.unlock(group.id));
  return (
    <div className="relative min-h-[60dvh]" data-testid="private-group-lock">
      {!password && (
        <div aria-hidden="true" inert className="blur-xl pointer-events-none select-none">
          {children}
        </div>
      )}
      <div className="absolute inset-0 flex items-start justify-center pt-[18dvh]">
        <button
          type="button"
          onClick={open}
          className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container-high/90 px-8 py-6 shadow-sm border border-surface-variant/40 text-on-surface"
        >
          <span className="w-12 h-12 rounded-full bg-surface-container flex items-center justify-center text-primary">
            <Icon name="lock" size={22} />
          </span>
          <span className="font-title-editorial text-sm font-semibold">
            {t("groups.locked", { name: group.name })}
          </span>
          <span className="text-xs text-secondary">{t("groups.lockedCount", { count })}</span>
          <span className="mt-1 rounded-full bg-primary text-on-primary px-4 py-1.5 text-xs">
            {password ? t("groups.unlock") : t("groups.reveal")}
          </span>
        </button>
      </div>
      {asking && <UnlockDialog group={group} onClose={() => setAsking(false)} />}
    </div>
  );
}

/** Asks for a password group's password; the core checks it. */
function UnlockDialog({ group, onClose }: { group: LibraryGroup; onClose: () => void }) {
  const { store } = useShelf();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-surface border-surface-variant/50 max-w-sm w-[calc(100%-2rem)] rounded-2xl p-5 space-y-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base font-semibold text-left">
            {t("groups.unlockTitle", { name: group.name })}
          </DialogTitle>
          <DialogDescription className="text-secondary text-xs text-left">
            {t("groups.lock.passwordNote")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            store.unlock(group.id, password).then(onClose, (failure: unknown) => {
              reportError(failure);
              setBusy(false);
            });
          }}
        >
          <Input
            autoFocus
            type="password"
            autoComplete="off"
            aria-label={t("groups.lock.password")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-9 bg-surface-container"
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !password}>
              {t("groups.open")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

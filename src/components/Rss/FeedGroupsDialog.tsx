import { useState } from "react";
import { useFeeds } from "../../application/runtime";
import { useT } from "../../i18n";
import { describeError } from "../Cloud/format";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";

/**
 * 分组管理 for 订阅, laid out as the shelf's: the groups in order (moved up
 * and down), a new one, and a chosen one renamed or removed (its feeds
 * ungrouped, or unsubscribed too).
 */
export function FeedGroupsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { state, store } = useFeeds();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState<"keep" | "all" | null>(null);
  const [busy, setBusy] = useState(false);
  const names = state.groups.map((group) => group.name);
  const count = (group: string) => state.feeds.filter((feed) => feed.group === group).length;
  const run = (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    void work()
      .then(
        () => done && toast(done),
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => setBusy(false));
  };
  const move = (index: number, by: number) => {
    const order = [...names];
    const [group] = order.splice(index, 1);
    order.splice(index + by, 0, group);
    run(() => store.saveGroups(order));
  };
  const field = "h-8 text-xs bg-surface-container";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-surface border-surface-variant/50 max-w-sm w-[calc(100%-2rem)] rounded-2xl p-5 space-y-4">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base font-semibold text-on-surface text-left">
            {t("rss.groups")}
          </DialogTitle>
          <DialogDescription className="text-secondary text-xs text-left">
            {t("rss.groups.note")}
          </DialogDescription>
        </DialogHeader>
        {selected !== null ? (
          <div className="space-y-3 text-xs">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1"
              onClick={() => {
                setSelected(null);
                setRemoving(null);
                setName("");
              }}
            >
              <Icon name="arrow_back" size={14} />
              {t("rss.groups.all")}
            </Button>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const from = selected;
                run(async () => {
                  await store.renameGroup(from, name);
                  setSelected(name.trim());
                }, t("rss.saved"));
              }}
            >
              <Input
                aria-label={t("rss.groups.newName")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={field}
              />
              <Button
                type="submit"
                size="sm"
                disabled={busy || !name.trim() || name.trim() === selected}
                className="h-8 text-xs"
              >
                {t("rss.groups.rename")}
              </Button>
            </form>
            <div className="space-y-2 border-t border-surface-variant/30 pt-3">
              <p className="text-on-surface font-medium">{t("rss.groups.remove")}</p>
              <div role="radiogroup" aria-label={t("rss.groups.remove")} className="space-y-1.5">
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
              {removing && (
                <Button
                  size="sm"
                  disabled={busy}
                  className="w-full bg-error text-on-error"
                  onClick={() => {
                    const group = selected;
                    run(async () => {
                      await store.removeGroup(group, removing === "all");
                      setSelected(null);
                      setRemoving(null);
                      setName("");
                    }, t("rss.groups.removed"));
                  }}
                >
                  {t("rss.groups.remove.confirm", { group: selected })}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            {names.length === 0 ? (
              <p className="text-xs text-secondary">{t("rss.groups.empty")}</p>
            ) : (
              <ul className="space-y-1.5 text-xs max-h-72 overflow-auto">
                {names.map((group, index) => (
                  <li
                    key={group}
                    className="flex items-center gap-1 rounded-lg bg-surface-container pr-1"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(group);
                        setName(group);
                      }}
                      className="flex-1 min-w-0 flex items-center justify-between py-1.5 px-2 text-left"
                    >
                      <span className="truncate text-on-surface font-medium">{group}</span>
                      <span className="shrink-0 text-secondary text-[11px]">
                        {t("rss.groups.feeds", { count: count(group) })}{" "}
                        <span aria-hidden="true">›</span>
                      </span>
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={t("rss.groups.up", { group })}
                      disabled={busy || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <Icon name="arrow_upward" size={14} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={t("rss.groups.down", { group })}
                      disabled={busy || index === names.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <Icon name="arrow_downward" size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const created = name.trim();
                run(async () => {
                  await store.saveGroups([...names, created]);
                  setName("");
                });
              }}
            >
              <Input
                aria-label={t("rss.groups.newName")}
                placeholder={t("rss.groups.newName")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={field}
              />
              <Button
                type="submit"
                size="sm"
                disabled={busy || !name.trim() || names.includes(name.trim())}
                className="h-8 text-xs"
              >
                {t("rss.groups.add")}
              </Button>
            </form>
          </>
        )}
        <DialogFooter className="pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

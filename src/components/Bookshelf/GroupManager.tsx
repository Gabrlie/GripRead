import { useState } from "react";
import { useLibrary, useShelf } from "../../application/runtime";
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
            <Button
              variant="outline"
              size="sm"
              className="text-xs text-error h-7"
              disabled={state.saving}
              onClick={() =>
                run(async () => {
                  await store.remove(selected.id);
                  setSelectedId(null);
                  setName("");
                })
              }
            >
              {t("groups.delete")}
            </Button>
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
                  <span className="text-on-surface font-medium">{group.name}</span>
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

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
            分组管理
          </DialogTitle>
          <DialogDescription className="text-secondary text-xs text-left">
            在读、未读、读完会按进度自动分组；这里管理你自己的分组。
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
              全部分组
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
                aria-label="分组名称"
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
                保存
              </Button>
            </form>
            <p className="text-secondary">在书籍详情页可以把书移入或移出这个分组。</p>
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
              删除分组（书籍回到自动分组）
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
                    本 <span aria-hidden="true">›</span>
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
                aria-label="新分组名称"
                placeholder="新分组名称"
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
                添加
              </Button>
            </form>
          </>
        )}
        <DialogFooter className="pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

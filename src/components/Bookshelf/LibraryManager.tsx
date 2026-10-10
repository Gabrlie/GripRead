import { useEffect } from "react";
import { useLibrary, useShelfPreferences } from "../../application/runtime";
import { useApp } from "../../context/AppContext";
import type { ShelfSort } from "../../types/generated";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";

export function LibraryManager({
  mode,
  onClose,
}: {
  mode: "removed" | "sort" | null;
  onClose: () => void;
}) {
  const { state, store } = useLibrary();
  const preferences = useShelfPreferences();
  const { shelf, setShelf } = useApp();
  useEffect(() => {
    if (mode === "removed") void store.loadRemoved();
  }, [mode, store]);
  const run = (action: () => Promise<void>) =>
    void action().catch(() => {
      /* The application store owns the visible operation error. */
    });
  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="bg-surface border-surface-variant/50 max-w-sm w-[calc(100%-2rem)] rounded-2xl p-5 space-y-4">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {mode === "sort" ? "书架排序" : "已移出书籍"}
          </DialogTitle>
          <DialogDescription className="text-xs text-secondary">
            {mode === "sort"
              ? "排序和书架布局自动保存。"
              : "恢复后继续使用原来的进度、书签和分组。"}
          </DialogDescription>
        </DialogHeader>
        {(state.managementError || preferences.state.error) && (
          <div role="alert" className="text-xs text-error">
            {state.managementError || preferences.state.error}
            {preferences.state.error && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  preferences.state.value
                    ? preferences.store.retry()
                    : void preferences.store.load()
                }
              >
                重试保存
              </Button>
            )}
            {mode === "removed" && (
              <Button variant="outline" size="sm" onClick={() => void store.loadRemoved()}>
                重新加载
              </Button>
            )}
          </div>
        )}
        {mode === "sort" && (
          <div className="space-y-2">
            {(
              [
                ["recent_read", "最近阅读"],
                ["imported", "导入时间"],
                ["title", "书名"],
              ] as const
            ).map(([sort, label]: readonly [ShelfSort, string]) => (
              <Button
                key={sort}
                variant="ghost"
                disabled={!preferences.state.value}
                aria-pressed={shelf.sort === sort}
                onClick={() => setShelf({ sort })}
                className={`w-full text-left justify-between text-xs h-10 rounded-xl ${shelf.sort === sort ? "bg-surface-container text-primary" : "text-secondary"}`}
              >
                {label}
                {shelf.sort === sort && <span aria-hidden="true">✓</span>}
              </Button>
            ))}
          </div>
        )}
        {mode === "removed" && (
          <div className="space-y-2 max-h-80 overflow-auto">
            {(state.removedLoading || !state.removedLoaded) && (
              <p role="status" className="text-xs text-secondary">
                正在读取已移出书籍…
              </p>
            )}
            {state.removedLoaded &&
              !state.removedLoading &&
              state.removedBooks.length === 0 &&
              !state.managementError && (
                <p className="text-xs text-secondary">没有已移出的书籍。</p>
              )}
            {state.removedBooks.map(({ book }) => (
              <div
                key={book.id}
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-surface-container-low"
              >
                <div className="min-w-0">
                  <p className="font-title-editorial text-sm truncate">{book.title}</p>
                  <p className="text-xs text-secondary truncate">{book.author ?? "作者未知"}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs shrink-0"
                  aria-label={`恢复 ${book.title}`}
                  disabled={state.managing}
                  onClick={() => run(() => store.restore(book.id))}
                >
                  恢复
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import { useLibrary, useShelfPreferences } from "../../application/runtime";
import { useApp } from "../../context/AppContext";
import type { ShelfSort } from "../../types/generated";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function LibraryManager({
  mode,
  onClose,
}: {
  mode: "manage" | "removed" | "sort" | null;
  onClose: () => void;
}) {
  const { state, store } = useLibrary();
  const preferences = useShelfPreferences();
  const { shelf, setShelf } = useApp();
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [saved, setSaved] = useState(false);
  const selected = state.books.find((book) => book.book.id === selectedId) ?? state.books[0];
  useEffect(() => {
    if (mode === "removed") void store.loadRemoved();
  }, [mode, store]);
  useEffect(() => {
    setTitle(selected?.book.title ?? "");
    setAuthor(selected?.book.author ?? "");
    setSaved(false);
  }, [selected?.book.id, mode]);
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
            {mode === "sort" ? "书架排序" : mode === "removed" ? "已移出书籍" : "书籍管理"}
          </DialogTitle>
          <DialogDescription className="text-xs text-secondary">
            {mode === "sort"
              ? "排序和书架布局自动保存。"
              : mode === "removed"
                ? "恢复后继续使用原来的进度、书签和分组。"
                : "编辑书籍信息；移出书架会保留正文和阅读记录。"}
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
        {mode === "manage" &&
          (selected ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  await store.edit({
                    bookId: selected.book.id,
                    title,
                    author: author.trim() || null,
                  });
                  setSaved(true);
                });
              }}
            >
              <label className="block text-xs text-secondary space-y-1">
                <span>选择书籍</span>
                <select
                  aria-label="管理的书籍"
                  value={selected.book.id}
                  disabled={state.managing}
                  onChange={(event) => setSelectedId(event.target.value)}
                  className="w-full h-9 rounded-lg bg-surface-container border border-surface-variant px-2"
                >
                  {state.books.map(({ book }) => (
                    <option key={book.id} value={book.id}>
                      {book.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-secondary space-y-1">
                <span>书名</span>
                <Input
                  aria-label="书名"
                  required
                  maxLength={512}
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setSaved(false);
                  }}
                  className="h-9 text-sm bg-surface-container"
                />
              </label>
              <label className="block text-xs text-secondary space-y-1">
                <span>作者</span>
                <Input
                  aria-label="作者"
                  maxLength={256}
                  value={author}
                  onChange={(event) => {
                    setAuthor(event.target.value);
                    setSaved(false);
                  }}
                  className="h-9 text-sm bg-surface-container"
                />
              </label>
              {saved && (
                <p role="status" className="text-xs text-primary">
                  书籍信息已保存
                </p>
              )}
              <div className="flex justify-between gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs text-error"
                  disabled={state.managing}
                  onClick={() =>
                    run(async () => {
                      await store.remove(selected);
                      onClose();
                    })
                  }
                >
                  移出书架
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  className="text-xs"
                  disabled={state.managing || !title.trim()}
                >
                  保存信息
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-xs text-secondary">书架暂无书籍。</p>
          ))}
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

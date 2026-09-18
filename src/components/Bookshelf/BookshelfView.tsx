import { useEffect, useState } from "react";
import { useApp } from "../../context/AppContext";
import { useLibrary } from "../../application/runtime";
import { Header } from "../Layout/Header";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";

export function BookshelfView() {
  const { shelf, setShelf, openReader } = useApp();
  const { state, store } = useLibrary();
  const [searching, setSearching] = useState(Boolean(shelf.query));
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    window.scrollTo(0, shelf.scroll);
    let last = window.scrollY;
    const scroll = () => {
      const next = window.scrollY;
      if (next < 15 || next < last - 6) setCollapsed(false);
      else if (next > last + 6 && next > 56) setCollapsed(true);
      last = next;
    };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => window.removeEventListener("scroll", scroll);
  }, []);
  const filtered = state.books.filter(
    (item) =>
      (shelf.filter === "all" || item.asset.availability === shelf.filter) &&
      `${item.book.title} ${item.book.author ?? ""}`
        .toLocaleLowerCase()
        .includes(shelf.query.trim().toLocaleLowerCase()),
  );
  const toggle = () => setShelf({ layout: shelf.layout === "list" ? "grid" : "list" });
  return (
    <div className="flex-1 flex flex-col relative w-full bg-surface">
      <div
        className={`fixed top-0 left-0 right-0 z-30 md:left-64 glass-header transition-transform duration-200 shadow-sm ${collapsed ? "-translate-y-14" : ""}`}
      >
        <Header
          title="书架"
          standalone={false}
          action={
            <Button
              data-testid="import-button"
              variant="outline"
              size="sm"
              disabled={state.importing}
              onClick={() => void store.importTxt()}
              className="text-primary mr-1"
            >
              <Icon name="add" size={16} />
              导入
            </Button>
          }
          onSearchClick={() => setSearching((value) => !value)}
          onUpdateToc={() => void store.refresh()}
          onAddLocal={() => void store.importTxt()}
          onToggleLayout={toggle}
        />
        <div className="py-2 px-3 sm:px-4 md:px-8 flex gap-2 items-center">
          <Tabs
            value={shelf.filter}
            onValueChange={(value) => setShelf({ filter: value as typeof shelf.filter })}
            className="flex-1 min-w-0"
          >
            <TabsList className="bg-surface-container/60 overflow-x-auto justify-start w-full gap-1">
              <TabsTrigger value="all">全部</TabsTrigger>
              <TabsTrigger value="ready">本地可读</TabsTrigger>
              <TabsTrigger value="missing">文件缺失</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={shelf.layout === "list" ? "切换为网格视图" : "切换为列表视图"}
          >
            <Icon name={shelf.layout === "list" ? "grid_view" : "view_list"} />
          </Button>
        </div>
      </div>
      <div className="w-full max-w-5xl mx-auto px-3 sm:px-4 md:px-8 pt-[112px] pb-28 md:pb-8">
        {searching && (
          <Input
            autoFocus
            aria-label="搜索本地书籍"
            placeholder="搜索书名或作者…"
            value={shelf.query}
            onChange={(event) => setShelf({ query: event.target.value })}
            className="mb-4 bg-surface-container"
          />
        )}
        {state.error && (
          <div role="alert" className="mb-4 rounded-xl bg-error-container text-error p-4 text-sm">
            书架读取失败：{state.error}
            <Button className="ml-3" variant="outline" onClick={() => void store.refresh()}>
              重试
            </Button>
          </div>
        )}
        {state.loading && (
          <p role="status" className="text-secondary py-3">
            正在读取本地书架…
          </p>
        )}
        {!state.loading && !state.error && filtered.length === 0 && (
          <div className="bg-surface-container-low rounded-2xl p-10 text-center my-6 space-y-4 border border-surface-variant/30">
            <Icon name="auto_stories" size={32} className="mx-auto text-secondary" />
            <p>{state.books.length ? "没有符合条件的书籍" : "从一本本地小说开始"}</p>
            <p className="text-sm text-secondary">支持 UTF-8 TXT，可离线阅读。</p>
            <Button disabled={state.importing} onClick={() => void store.importTxt()}>
              导入本地小说
            </Button>
          </div>
        )}
        <section
          aria-label="书架书籍列表"
          className={
            shelf.layout === "list"
              ? "flex flex-col gap-3"
              : "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4"
          }
        >
          {filtered.map((item) => {
            const percent =
              item.totalLength && item.locator
                ? Math.floor((item.locator.offset / item.totalLength) * 100)
                : 0;
            return (
              <button
                key={item.book.id}
                data-testid={`library-book-${item.book.id}`}
                onClick={() => openReader(item)}
                className={`text-left rounded-2xl bg-surface-container-low border border-surface-variant/60 p-4 hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${shelf.layout === "list" ? "flex gap-4 items-center" : "flex flex-col gap-3"}`}
              >
                <div
                  aria-hidden="true"
                  className="w-20 h-28 shrink-0 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center p-3 font-title-editorial text-primary overflow-hidden"
                >
                  {item.book.title.slice(0, 12)}
                </div>
                <div className="min-w-0 space-y-2">
                  <h2 className="font-title-editorial text-lg truncate">{item.book.title}</h2>
                  <p className="text-xs text-secondary">{item.book.author ?? "作者未知"}</p>
                  <p className="text-xs text-secondary">
                    {item.locator ? `已读 ${percent}%` : "尚未阅读"} · 全文
                  </p>
                  <p
                    className={`text-xs ${item.asset.availability === "missing" ? "text-error" : "text-secondary"}`}
                  >
                    {item.asset.availability === "missing"
                      ? "本地文件缺失，请重新导入原文件"
                      : "本地 TXT"}
                  </p>
                </div>
              </button>
            );
          })}
        </section>
      </div>
    </div>
  );
}

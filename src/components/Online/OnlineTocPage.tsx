import { useMemo, useRef, useState } from "react";
import type { OnlineChapter } from "../../types/generated";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * An online book's 目录 as its own page, laid out like the local contents
 * page: collapsible volumes, filtering, reversed order, and the jump buttons.
 * Choosing a chapter calls `onChoose` with its position in `chapters`.
 */
export function OnlineTocPage({
  bookName,
  chapters,
  current = -1,
  onChoose,
  onClose,
}: {
  bookName: string;
  chapters: OnlineChapter[];
  /** The chapter being read, highlighted; -1 for none. */
  current?: number;
  onChoose: (index: number) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [reversed, setReversed] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const indexed = chapters.map((chapter, index) => ({ chapter, index }));
    const query = filter?.trim();
    if (query) return indexed.filter(({ chapter }) => chapter.title.includes(query));
    const visible: typeof indexed = [];
    let hidden = false;
    for (const row of indexed) {
      if (row.chapter.isVolume) {
        hidden = collapsed.has(row.index);
        visible.push(row);
      } else if (!hidden) visible.push(row);
    }
    return reversed ? visible.reverse() : visible;
  }, [chapters, filter, collapsed, reversed]);

  const volumes = chapters.flatMap((chapter, index) => (chapter.isVolume ? [index] : []));
  const count = chapters.length - volumes.length;
  const toggleVolume = (index: number) =>
    setCollapsed((value) => {
      const next = new Set(value);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="目录"
      data-open=""
      className="fixed inset-0 z-[46] bg-surface text-on-surface flex flex-col pt-safe pb-safe"
    >
      <header className="shrink-0 border-b border-surface-variant/30">
        <div className="h-14 px-2 flex items-center gap-1 max-w-3xl mx-auto w-full">
          <Button
            aria-label="返回"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full text-secondary shrink-0"
            onClick={onClose}
          >
            <Icon name="arrow_back" size={20} />
          </Button>
          {filter === null ? (
            <h2 className="flex-1 min-w-0 truncate font-title-editorial text-[15px] font-semibold">
              {bookName}
            </h2>
          ) : (
            <Input
              autoFocus
              aria-label="搜索章节"
              placeholder="搜索章节"
              className="flex-1 h-9"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          <Button
            aria-label={filter === null ? "搜索目录" : "关闭搜索"}
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full text-secondary shrink-0"
            onClick={() => setFilter((value) => (value === null ? "" : null))}
          >
            <Icon name={filter === null ? "search" : "close"} size={19} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="目录选项"
              className="h-9 w-9 rounded-full flex items-center justify-center text-secondary hover:bg-surface-container/60 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 shrink-0"
            >
              <Icon name="more_vert" size={19} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setReversed((value) => !value)}>
                {reversed ? (
                  <Icon name="check" size={15} />
                ) : (
                  <span aria-hidden="true" className="w-[15px]" />
                )}
                倒序显示
              </DropdownMenuItem>
              {volumes.length > 0 && (
                <DropdownMenuItem
                  onClick={() =>
                    setCollapsed((value) => (value.size ? new Set() : new Set(volumes)))
                  }
                >
                  <Icon name={collapsed.size ? "expand_more" : "expand_less"} size={15} />
                  {collapsed.size ? "展开全部卷" : "收起全部卷"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div ref={list} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="max-w-3xl mx-auto w-full">
          {rows.map(({ chapter, index }) => {
            if (chapter.isVolume && !filter?.trim())
              return (
                <div
                  key={index}
                  className="flex items-center gap-1 px-4 pt-4 pb-1.5 text-xs text-secondary"
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 36px" }}
                >
                  <span className="flex-1 min-w-0 truncate font-medium">{chapter.title}</span>
                  <button
                    aria-label={
                      collapsed.has(index) ? `展开 ${chapter.title}` : `收起 ${chapter.title}`
                    }
                    aria-expanded={!collapsed.has(index)}
                    className="h-7 w-7 flex items-center justify-center rounded-full hover:bg-surface-container"
                    onClick={() => toggleVolume(index)}
                  >
                    <Icon name={collapsed.has(index) ? "expand_more" : "expand_less"} size={15} />
                  </button>
                </div>
              );
            const isCurrent = index === current;
            return (
              <button
                key={index}
                aria-current={isCurrent ? "location" : undefined}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left text-sm border-b border-surface-variant/20 transition-colors ${isCurrent ? "text-primary bg-surface-container font-medium" : "hover:bg-surface-container/60"}`}
                style={{ contentVisibility: "auto", containIntrinsicSize: "auto 46px" }}
                onClick={() => onChoose(index)}
              >
                <span className="flex-1 min-w-0 truncate">{chapter.title}</span>
                {chapter.isVip && (
                  <span className="text-[10px] text-secondary shrink-0">
                    {chapter.isPay ? "已购" : "VIP"}
                  </span>
                )}
                {isCurrent && <Icon name="my_location" size={14} className="shrink-0" />}
              </button>
            );
          })}
          {chapters.length === 0 && <p className="m-4 text-sm text-secondary">目录为空。</p>}
        </div>
      </div>

      <footer className="shrink-0 border-t border-surface-variant/30">
        <div className="max-w-3xl mx-auto w-full flex items-center gap-1 px-3 py-1.5">
          <p className="flex-1 min-w-0 text-[11px] text-secondary">共 {count} 章</p>
          <Button
            aria-label="回到顶部"
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-secondary"
            onClick={() => list.current?.scrollTo({ top: 0 })}
          >
            <Icon name="vertical_align_top" size={18} />
          </Button>
          <Button
            aria-label="滚到底部"
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-secondary"
            onClick={() => list.current?.scrollTo({ top: list.current.scrollHeight })}
          >
            <Icon name="vertical_align_bottom" size={18} />
          </Button>
        </div>
      </footer>
    </div>
  );
}

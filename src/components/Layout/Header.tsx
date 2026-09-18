import React from "react";
import { Icon } from "../ui/Icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

interface HeaderProps {
  title: string;
  subtitle?: string;
  readingTime?: string;
  action?: React.ReactNode;
  standalone?: boolean;
  onSearchClick?: () => void;
  onMoreClick?: () => void;
  onUpdateToc?: () => void;
  onAddLocal?: () => void;
  onRemoteBooks?: () => void;
  onToggleLayout?: () => void;
  onCacheManage?: () => void;
  onGroupManage?: () => void;
}

export function Header({
  title,
  subtitle,
  readingTime,
  action,
  standalone = true,
  onSearchClick,
  onMoreClick,
  onUpdateToc,
  onAddLocal,
  onRemoteBooks,
  onToggleLayout,
  onCacheManage,
  onGroupManage,
}: HeaderProps) {
  const hasShelfOptions = Boolean(
    onUpdateToc || onAddLocal || onRemoteBooks || onToggleLayout || onCacheManage || onGroupManage,
  );

  const content = (
    <div className="h-14 px-3 sm:px-4 md:px-8 flex items-center justify-between w-full">
      {/* Left Title and Today's Reading Time */}
      <div className="flex items-center gap-2.5 min-w-0">
        <h1 className="font-title-editorial text-lg sm:text-xl text-on-surface tracking-tight font-semibold leading-none truncate select-none">
          {title}
        </h1>

        {/* Reading Time placed immediately right of Bookshelf title with precise optical vertical centering */}
        {readingTime && (
          <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-container text-secondary text-xs font-label-md shrink-0 border border-surface-variant/40 shadow-sm leading-none select-none translate-y-[2px]">
            <Icon name="schedule" size={13} className="text-primary shrink-0" />
            <span className="leading-none">今日 {readingTime}</span>
          </div>
        )}

        {subtitle && !readingTime && (
          <span className="font-label-caps text-label-caps text-secondary uppercase tracking-widest hidden sm:inline truncate">
            {subtitle}
          </span>
        )}
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {action}

        {onSearchClick && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onSearchClick}
            aria-label="搜索"
            className="text-secondary hover:text-on-surface hover:bg-surface-container rounded-full"
          >
            <Icon name="search" size={20} />
          </Button>
        )}

        {/* 更多按钮：使用下拉菜单组件 (DropdownMenu) */}
        {hasShelfOptions ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex items-center justify-center size-8 rounded-full text-secondary hover:text-on-surface hover:bg-surface-container transition-colors cursor-pointer outline-none"
              aria-label="更多选项"
            >
              <Icon name="more_horiz" size={20} />
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" sideOffset={6} className="w-48">
              <DropdownMenuItem
                disabled={!onUpdateToc}
                onClick={onUpdateToc}
                className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-on-surface rounded-xl cursor-pointer hover:bg-surface-container/60 focus:bg-surface-container/60 transition-colors"
              >
                <Icon name="sync" size={16} className="text-primary" />
                <span>刷新书架</span>
              </DropdownMenuItem>

              <DropdownMenuItem
                disabled={!onAddLocal}
                onClick={onAddLocal}
                className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-on-surface rounded-xl cursor-pointer hover:bg-surface-container/60 focus:bg-surface-container/60 transition-colors"
              >
                <Icon name="folder_open" size={16} className="text-primary" />
                <span>添加本地</span>
              </DropdownMenuItem>

              <DropdownMenuItem
                disabled={!onRemoteBooks}
                onClick={onRemoteBooks}
                className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-on-surface rounded-xl cursor-pointer hover:bg-surface-container/60 focus:bg-surface-container/60 transition-colors"
              >
                <Icon name="cloud" size={16} className="text-primary" />
                <span>远程书籍 · 未开放</span>
              </DropdownMenuItem>

              <DropdownMenuItem
                disabled={!onToggleLayout}
                onClick={onToggleLayout}
                className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-on-surface rounded-xl cursor-pointer hover:bg-surface-container/60 focus:bg-surface-container/60 transition-colors"
              >
                <Icon name="grid_view" size={16} className="text-primary" />
                <span>书架布局</span>
              </DropdownMenuItem>

              <DropdownMenuItem
                disabled={!onCacheManage}
                onClick={onCacheManage}
                className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-on-surface rounded-xl cursor-pointer hover:bg-surface-container/60 focus:bg-surface-container/60 transition-colors"
              >
                <Icon name="pie_chart" size={16} className="text-primary" />
                <span>书籍缓存 · 未开放</span>
              </DropdownMenuItem>

              <DropdownMenuItem
                disabled={!onGroupManage}
                onClick={onGroupManage}
                className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-on-surface rounded-xl cursor-pointer hover:bg-surface-container/60 focus:bg-surface-container/60 transition-colors"
              >
                <Icon name="label" size={16} className="text-primary" />
                <span>分组管理 · 未开放</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : onMoreClick ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onMoreClick}
            aria-label="更多选项"
            className="text-secondary hover:text-on-surface hover:bg-surface-container rounded-full"
          >
            <Icon name="more_horiz" size={20} />
          </Button>
        ) : null}
      </div>
    </div>
  );

  if (!standalone) {
    return content;
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-30 glass-header pt-safe md:left-64 shadow-[0_1px_12px_rgba(68,60,50,0.03)]">
      {content}
    </header>
  );
}

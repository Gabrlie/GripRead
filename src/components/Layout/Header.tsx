import React from "react";
import { Icon } from "../ui/Icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { t } from "../../i18n";

export interface HeaderMenuItem {
  icon: string;
  label: string;
  onSelect: () => void;
  /** A short state shown at the end of the row, such as the current layout. */
  detail?: string;
}

interface HeaderProps {
  title: string;
  subtitle?: string;
  readingTime?: string;
  action?: React.ReactNode;
  standalone?: boolean;
  onSearchClick?: () => void;
  searchDisabled?: boolean;
  onMoreClick?: () => void;
  /** Rows of the 更多 menu; without them the button calls `onMoreClick`. */
  menuItems?: HeaderMenuItem[];
}

export function Header({
  title,
  subtitle,
  readingTime,
  action,
  standalone = true,
  onSearchClick,
  searchDisabled = false,
  onMoreClick,
  menuItems,
}: HeaderProps) {
  const content = (
    <div className="h-14 px-margin-mobile md:px-8 flex items-center justify-between w-full">
      {/* Left Title, Subtitle, and Reading Time */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="font-title-editorial text-title-editorial sm:text-xl text-on-surface tracking-tight font-semibold truncate select-none">
            {title}
          </h1>

          {subtitle && !readingTime && (
            <span className="font-label-caps text-label-caps text-secondary uppercase tracking-widest hidden sm:inline truncate select-none">
              {subtitle}
            </span>
          )}
        </div>

        {/* Reading Time placed immediately right of Bookshelf title with precise optical vertical centering */}
        {readingTime && (
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-surface-container/75 text-secondary text-xs font-label-md shrink-0 border border-surface-variant/40 shadow-xs leading-none select-none">
            <Icon name="schedule" size={13} className="text-primary shrink-0" />
            <span className="leading-none pt-[0.5px]">
              {t("header.today", { time: readingTime })}
            </span>
          </div>
        )}
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {action}

        {(onSearchClick || searchDisabled) && (
          <button
            type="button"
            onClick={onSearchClick}
            disabled={searchDisabled}
            title={searchDisabled ? t("header.searchOff") : undefined}
            aria-label={t("header.search")}
            className="w-10 h-10 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container/60 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Icon name="search" size={20} />
          </button>
        )}

        {/* 更多按钮：使用下拉菜单组件 (DropdownMenu) */}
        {menuItems?.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="w-10 h-10 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container/60 transition-colors cursor-pointer outline-none"
              aria-label={t("header.more")}
            >
              <Icon name="more_horiz" size={20} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-48">
              {menuItems.map((item) => (
                <DropdownMenuItem
                  key={item.label}
                  onClick={item.onSelect}
                  className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-on-surface rounded-xl cursor-pointer hover:bg-surface-container/60 focus:bg-surface-container/60 transition-colors"
                >
                  <Icon name={item.icon} size={16} className="text-primary" />
                  <span className="flex-1">{item.label}</span>
                  {item.detail && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-secondary font-medium select-none">
                      {item.detail}
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : onMoreClick ? (
          <button
            type="button"
            onClick={onMoreClick}
            aria-label={t("header.more")}
            className="w-10 h-10 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container/60 transition-colors cursor-pointer"
          >
            <Icon name="more_horiz" size={20} />
          </button>
        ) : null}
      </div>
    </div>
  );

  if (!standalone) {
    return content;
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-30 glass-header pt-safe md:left-64">
      {content}
    </header>
  );
}

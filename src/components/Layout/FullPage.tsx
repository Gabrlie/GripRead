import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { usePageLayer } from "./use-page-layer";

/**
 * A full-screen page over the app (settings sub-pages, the cloud
 * bookshelf, rule management): a title bar with back and actions, and a
 * scrolling body. The Android back gesture closes it like the back button.
 */
export function FullPage({
  label,
  onClose,
  actions,
  children,
  layer = "z-40",
}: {
  label: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
  /** Stacking order; pages opened from another page sit above it. */
  layer?: string;
}) {
  const page = usePageLayer(onClose);
  return (
    <div
      ref={page}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-open=""
      className={`fixed inset-0 ${layer} bg-surface text-on-surface flex flex-col overflow-hidden pt-safe pb-safe`}
    >
      <header className="shrink-0 border-b border-surface-variant/30">
        <div className="h-14 px-2 flex items-center gap-1 max-w-3xl mx-auto w-full">
          <Button
            variant="ghost"
            size="icon"
            aria-label="返回"
            className="h-9 w-9 rounded-full text-secondary"
            onClick={onClose}
          >
            <Icon name="arrow_back" size={20} />
          </Button>
          <h1 className="flex-1 min-w-0 truncate font-title-editorial text-base font-semibold">
            {label}
          </h1>
          {actions}
        </div>
      </header>
      {/* The frame, not the scroll body, keeps clear of the gesture bar: a
          scroll body's padding scrolls, and text would show below bars. */}
      <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="max-w-3xl mx-auto w-full px-3 py-3 space-y-3">{children}</div>
      </main>
    </div>
  );
}

/** A titled group of rows inside a page. */
export function PageSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      {title && <h2 className="px-1 text-[11px] font-medium text-secondary">{title}</h2>}
      <div className="rounded-xl bg-surface-container-low overflow-hidden divide-y divide-surface-variant/30">
        {children}
      </div>
    </section>
  );
}

/** A row that opens something, with an icon, a label, and an optional detail. */
export function PageLink({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: string;
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-container transition-colors"
    >
      <Icon name={icon} size={18} className="text-primary shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-sm truncate">{label}</span>
        {detail && <span className="block text-[11px] text-secondary truncate">{detail}</span>}
      </span>
      <Icon name="chevron_right" size={16} className="text-outline-variant shrink-0" />
    </button>
  );
}

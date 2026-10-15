import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { readerSelection, type ReaderSelection } from "./selection";
import { t } from "../../i18n";

export interface SelectionActions {
  copy: (selection: ReaderSelection) => void;
  bookmark: (selection: ReaderSelection) => void;
  search: (selection: ReaderSelection) => void;
  share: (selection: ReaderSelection) => void;
  replace: (selection: ReaderSelection) => void;
}

const ACTIONS: { key: keyof SelectionActions; label: string; icon: string }[] = [
  {
    key: "copy",
    get label() {
      return t("reader.copy");
    },
    icon: "content_copy",
  },
  {
    key: "bookmark",
    get label() {
      return t("style.tap.bookmark");
    },
    icon: "bookmark_add",
  },
  {
    key: "search",
    get label() {
      return t("header.search");
    },
    icon: "search",
  },
  {
    key: "replace",
    get label() {
      return t("reader.tool.replace");
    },
    icon: "find_replace",
  },
  {
    key: "share",
    get label() {
      return t("logs.share");
    },
    icon: "share",
  },
];

/**
 * Legado's text action menu: after a long press selects text on the page, a
 * floating bar offers copy, bookmark (with a note), search, a replace rule
 * for the selected text, and share. It
 * waits until the selection stops changing, so dragging a handle does not
 * make it jump.
 */
export function SelectionMenu({
  enabled,
  actions,
}: {
  enabled: boolean;
  actions: SelectionActions;
}) {
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }
    let timer = 0;
    const update = () => {
      window.clearTimeout(timer);
      setSelection(null);
      timer = window.setTimeout(() => setSelection(readerSelection(window.getSelection())), 250);
    };
    document.addEventListener("selectionchange", update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", update);
    };
  }, [enabled]);
  if (!selection) return null;
  const above = selection.rect.top > 64;
  const center = (selection.rect.left + selection.rect.right) / 2;
  return (
    <div
      role="toolbar"
      aria-label={t("reader.selection")}
      data-reader-control=""
      className="fixed z-[60] -translate-x-1/2 flex items-center gap-0.5 rounded-xl bg-inverse-surface text-inverse-on-surface shadow-lg px-1 py-1"
      style={{
        left: Math.min(Math.max(center, 120), window.innerWidth - 120),
        top: above ? selection.rect.top - 52 : selection.rect.bottom + 12,
      }}
      // Keep the selection while pressing a button.
      onPointerDown={(event) => event.preventDefault()}
    >
      {ACTIONS.map((action) => (
        <button
          key={action.key}
          type="button"
          className="flex flex-col items-center gap-0.5 min-w-12 px-2 py-1 rounded-lg text-[11px] hover:bg-white/10"
          onClick={() => {
            const current = selection;
            setSelection(null);
            window.getSelection()?.removeAllRanges();
            actions[action.key](current);
          }}
        >
          <Icon name={action.icon} size={16} />
          {action.label}
        </button>
      ))}
    </div>
  );
}

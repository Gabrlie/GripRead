import { useCallback, useRef, useState } from "react";

/**
 * Reader tools, following Legado's read menu: full-screen Contents and Search
 * pages, the chapter rule and encoding dialogs, and the 界面 style sheet.
 */
export type ReaderPanel = "contents" | "search" | "rules" | "encoding" | "style" | "automatic";

/** Accessible labels of the menu buttons that open each top-level panel. */
export const PANEL_TRIGGER_LABELS: Record<ReaderPanel, string> = {
  contents: "目录",
  search: "搜索",
  rules: "TXT目录规则",
  encoding: "设置编码",
  style: "界面",
  automatic: "自动翻页",
};

/**
 * One panel state for every reader tool. Nested panels push onto a back
 * stack; closing the last panel restores focus to the menu button that
 * opened it without delivering the dismissal to the page.
 */
export function useReaderPanel(onClose?: (panel: ReaderPanel) => void) {
  const [stack, setStack] = useState<ReaderPanel[]>([]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const panel = stack.at(-1) ?? null;

  const open = useCallback((next: ReaderPanel) => setStack([next]), []);
  const push = useCallback((next: ReaderPanel) => setStack((current) => [...current, next]), []);
  const close = useCallback(() => {
    const current = stackRef.current;
    if (current.length === 0) return;
    for (const closing of [...current].reverse()) onClose?.(closing);
    setStack([]);
    const root = current[0];
    queueMicrotask(() => {
      document
        .querySelector<HTMLButtonElement>(`button[aria-label="${PANEL_TRIGGER_LABELS[root]}"]`)
        ?.focus();
    });
  }, [onClose]);
  /** Return to the previous panel, or close when this is the root panel. */
  const back = useCallback(() => {
    if (stackRef.current.length <= 1) {
      close();
      return;
    }
    const closing = stackRef.current.at(-1);
    if (closing) onClose?.(closing);
    setStack((current) => current.slice(0, -1));
  }, [close, onClose]);
  const current = useCallback(() => stackRef.current.at(-1) ?? null, []);
  return { panel, open, push, close, back, current };
}

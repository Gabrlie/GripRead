import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ContentWindow } from "../../types/generated";
import type { ReaderController } from "../../reader";
import { renderReaderText, continuesLine } from "../../reader";
import { rectAtOffset, visibleOffsets } from "../../reader/scroll-layout";
import { selectionActive } from "./ReaderSurface";

interface Props {
  window: ContentWindow;
  controller: ReaderController;
  viewport: RefObject<HTMLDivElement | null>;
  highlight: { start: number; end: number } | null;
  onInteract: () => void;
  run: (action: () => Promise<void>) => void;
  synchronize: RefObject<(() => void) | null>;
}

export function ReaderScrollText({
  window: content,
  controller,
  viewport,
  highlight,
  onInteract,
  run,
  synchronize,
}: Props) {
  const body = useRef<HTMLDivElement>(null);
  const previous = useRef<ContentWindow | null>(null);
  const frame = useRef(0);
  const report = useRef<() => void>(() => {});
  report.current = () => {
    if (!body.current || !viewport.current) return;
    const offsets = visibleOffsets(body.current, viewport.current);
    controller.updateScrollPosition(
      content.startOffset + offsets.start,
      content.startOffset + offsets.end,
    );
    const box = viewport.current;
    if (selectionActive() || controller.getSnapshot().error) return;
    // Preload within one viewport of either boundary; loading never replaces the visible page.
    const textHeight = body.current.getBoundingClientRect().height;
    if (content.hasAfter && box.scrollTop + box.clientHeight * 2 >= textHeight)
      run(() => controller.extendScroll("forward", () => !selectionActive()));
    else if (content.hasBefore && box.scrollTop < box.clientHeight)
      run(() => controller.extendScroll("backward", () => !selectionActive()));
  };
  useLayoutEffect(() => {
    const root = body.current;
    const box = viewport.current;
    if (!root || !box) return;
    const old = previous.current;
    const overlap =
      old &&
      old.contentVersion === content.contentVersion &&
      old.startOffset < content.endOffset &&
      content.startOffset < old.endOffset;
    const oldVisible = old && visibleOffsets(root, box);
    const anchor = old && oldVisible ? old.startOffset + oldVisible.start : content.startOffset;
    const oldRect = old && oldVisible ? rectAtOffset(root, oldVisible.start) : null;
    const oldTop = oldRect?.top;
    renderReaderText(root, content.text, {
      continued: continuesLine(
        content.text,
        0,
        content.startOffset > 0 && !content.locator.contextBefore.endsWith("\n"),
      ),
      highlight: highlight
        ? { start: highlight.start - content.startOffset, end: highlight.end - content.startOffset }
        : null,
    });
    previous.current = content;
    const target = controller.takeScrollTarget();
    if (target) {
      const endRect = rectAtOffset(
        root,
        Math.min(content.text.length - 1, target.offset - content.startOffset - 1),
      );
      const startRect = rectAtOffset(root, Math.max(0, target.start - content.startOffset));
      const top = box.getBoundingClientRect().top;
      box.scrollTop += Math.max(
        (startRect?.top ?? top) - top,
        (endRect?.bottom ?? top) - top - box.clientHeight,
      );
    } else if (
      overlap &&
      oldTop !== undefined &&
      anchor >= content.startOffset &&
      anchor < content.endOffset
    ) {
      const nextRect = rectAtOffset(root, anchor - content.startOffset);
      if (nextRect) box.scrollTop += nextRect.top - oldTop;
    } else {
      box.scrollTop = 0;
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => report.current());
    return () => cancelAnimationFrame(frame.current);
  }, [content, controller, highlight?.start, highlight?.end, viewport]);
  useLayoutEffect(() => {
    const box = viewport.current;
    if (!box) return;
    const sync = () => {
      if (!body.current) return;
      const offsets = visibleOffsets(body.current, box);
      const current = previous.current;
      if (current)
        controller.updateScrollPosition(
          current.startOffset + offsets.start,
          current.startOffset + offsets.end,
        );
      controller.capturePosition();
    };
    synchronize.current = sync;
    const onScroll = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => report.current());
    };
    const observer = new ResizeObserver(onScroll);
    observer.observe(box);
    box.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onScroll);
    return () => {
      if (synchronize.current === sync) synchronize.current = null;
      observer.disconnect();
      box.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onScroll);
      cancelAnimationFrame(frame.current);
    };
  }, [viewport, controller, synchronize]);
  return (
    <div
      ref={viewport}
      data-testid="reader-scroll"
      className="h-full overflow-y-auto overscroll-contain"
      style={{ overflowAnchor: "none" }}
      onWheel={onInteract}
      onTouchStart={onInteract}
    >
      <div
        ref={body}
        className="reader-prose reader-text"
        data-testid="reader-scroll-text"
        data-start={content.startOffset}
        data-end={content.endOffset}
        data-total={content.totalLength}
      />
      {!content.hasAfter && <div aria-hidden="true" style={{ height: "calc(100% - 1lh)" }} />}
    </div>
  );
}

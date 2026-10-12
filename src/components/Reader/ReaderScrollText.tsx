import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ContentWindow } from "../../types/generated";
import type { HeadingIndex, ReaderController } from "../../reader";
import { renderReaderText, continuesLine } from "../../reader";
import { rectAtOffset, visibleOffsets } from "../../reader/scroll-layout";
import { selectionActive } from "./ReaderSurface";

interface Props {
  window: ContentWindow;
  controller: ReaderController;
  viewport: RefObject<HTMLDivElement | null>;
  highlight: { start: number; end: number } | null;
  headings: HeadingIndex;
  onInteract: () => void;
  /** A drag or wheel movement; the overlay toolbars would otherwise cover text. */
  onUserScroll: () => void;
  run: (action: () => Promise<void>) => void;
  synchronize: RefObject<(() => void) | null>;
  /** A book read chapter by chapter: the chapters shown above and below. */
  before?: ContentWindow | null;
  after?: ContentWindow | null;
}

/** Renders a neighbouring chapter, or clears its box when there is none. */
function renderNeighbour(
  root: HTMLDivElement | null,
  content: ContentWindow | null,
  headings: HeadingIndex,
) {
  if (!root) return;
  if (!content) {
    root.replaceChildren();
    return;
  }
  renderReaderText(root, content.text, {
    continued: false,
    highlight: null,
    headings: headings.local(content.startOffset, content.endOffset),
  });
}

export function ReaderScrollText({
  window: content,
  controller,
  viewport,
  highlight,
  headings,
  onInteract,
  onUserScroll,
  run,
  synchronize,
  before = null,
  after = null,
}: Props) {
  const body = useRef<HTMLDivElement>(null);
  const beforeBody = useRef<HTMLDivElement>(null);
  const afterBody = useRef<HTMLDivElement>(null);
  const shown = useRef<{ before: ContentWindow | null; after: ContentWindow | null }>({
    before: null,
    after: null,
  });
  /** The passage at the top of the view, in any of the shown chapters. */
  const topPassage = (): { resourceId: string; offset: number; top: number } | null => {
    const box = viewport.current;
    if (!box) return null;
    const edge = box.getBoundingClientRect().top;
    const segments: [HTMLDivElement | null, ContentWindow | null][] = [
      [beforeBody.current, shown.current.before],
      [body.current, previous.current],
      [afterBody.current, shown.current.after],
    ];
    for (const [root, window] of segments) {
      if (!root || !window || root.getBoundingClientRect().bottom <= edge) continue;
      const local = visibleOffsets(root, box).start;
      const rect = rectAtOffset(root, local);
      return {
        resourceId: window.resourceId,
        offset: window.startOffset + local,
        top: rect?.top ?? edge,
      };
    }
    return null;
  };
  const indicator = useRef<HTMLDivElement>(null);
  const indicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPosition = (start: number) => {
    const thumb = indicator.current;
    if (!thumb || content.totalLength <= 0) return;
    const ratio = Math.min(1, Math.max(0, start / content.totalLength));
    thumb.style.top = `calc(${ratio} * (100% - 2.5rem))`;
    thumb.style.opacity = "1";
    if (indicatorTimer.current !== null) clearTimeout(indicatorTimer.current);
    indicatorTimer.current = setTimeout(() => {
      thumb.style.opacity = "0";
    }, 900);
  };
  const previous = useRef<ContentWindow | null>(null);
  const frame = useRef(0);
  /** Only user-visible scrolling reveals the indicator, not re-renders. */
  const scrolled = useRef(false);
  const report = useRef<() => void>(() => {});
  /**
   * The passage at the top of the view and how far its line sits above the
   * edge. A width change (such as a dialog's scroll lock) reflows the text;
   * the view then returns to this passage instead of reporting whatever
   * line the reflow pushed to the top.
   */
  const anchor = useRef<{ offset: number; delta: number } | null>(null);
  report.current = () => {
    if (!body.current || !viewport.current) return;
    // The chapter at the top of the view is the one being read.
    const edge = viewport.current.getBoundingClientRect().top;
    const current = body.current.getBoundingClientRect();
    // A view without layout (hidden, or not yet sized) has no top passage.
    const laidOut = current.height > 0 && viewport.current.clientHeight > 0;
    if (laidOut && after && current.bottom <= edge && controller.enterScrollChapter("forward"))
      return;
    if (laidOut && before && current.top > edge + 1 && controller.enterScrollChapter("backward"))
      return;
    const offsets = visibleOffsets(body.current, viewport.current);
    const top = rectAtOffset(body.current, offsets.start);
    anchor.current = {
      offset: content.startOffset + offsets.start,
      delta: top ? top.top - viewport.current.getBoundingClientRect().top : 0,
    };
    controller.updateScrollPosition(
      content.startOffset + offsets.start,
      content.startOffset + offsets.end,
    );
    const box = viewport.current;
    if (scrolled.current) showPosition(content.startOffset + offsets.start);
    scrolled.current = false;
    if (selectionActive() || controller.getSnapshot().error) return;
    // Preload within one viewport of either boundary; loading never replaces
    // the visible page. Past a chapter's ends, the neighbouring chapter loads.
    const view = box.getBoundingClientRect();
    const forward = content.hasAfter || (Boolean(content.nextResourceId) && !after);
    const backward = content.hasBefore || (Boolean(content.previousResourceId) && !before);
    if (forward && current.bottom - view.bottom < box.clientHeight)
      run(() => controller.extendScroll("forward", () => !selectionActive()));
    else if (backward && view.top - current.top < box.clientHeight)
      run(() => controller.extendScroll("backward", () => !selectionActive()));
  };
  useLayoutEffect(() => {
    const root = body.current;
    const box = viewport.current;
    if (!root || !box) return;
    const old = previous.current;
    // The passage at the top before rendering, in whichever chapter holds it.
    const kept = old ? topPassage() : null;
    if (shown.current.before !== before) renderNeighbour(beforeBody.current, before, headings);
    if (shown.current.after !== after) renderNeighbour(afterBody.current, after, headings);
    shown.current = { before, after };
    renderReaderText(root, content.text, {
      continued: continuesLine(
        content.text,
        0,
        content.startOffset > 0 && !content.locator.contextBefore.endsWith("\n"),
      ),
      highlight: highlight
        ? { start: highlight.start - content.startOffset, end: highlight.end - content.startOffset }
        : null,
      headings: headings.local(content.startOffset, content.endOffset),
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
    } else if (kept) {
      const segments: [HTMLDivElement | null, ContentWindow | null][] = [
        [beforeBody.current, before],
        [root, content],
        [afterBody.current, after],
      ];
      const holder = segments.find(
        ([element, window]) =>
          element &&
          window &&
          window.resourceId === kept.resourceId &&
          kept.offset >= window.startOffset &&
          kept.offset < window.endOffset,
      );
      const rect = holder ? rectAtOffset(holder[0]!, kept.offset - holder[1]!.startOffset) : null;
      if (rect) box.scrollTop += rect.top - kept.top;
      else if (!holder) box.scrollTop = beforeBody.current?.offsetHeight ?? 0;
    } else {
      box.scrollTop = beforeBody.current?.offsetHeight ?? 0;
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => report.current());
    return () => cancelAnimationFrame(frame.current);
  }, [content, before, after, controller, highlight?.start, highlight?.end, headings, viewport]);
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
      scrolled.current = true;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => report.current());
    };
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      const current = previous.current;
      const kept = anchor.current;
      if (box.clientWidth !== width && current && kept && body.current) {
        const local = kept.offset - current.startOffset;
        const rect =
          local >= 0 && local < current.text.length ? rectAtOffset(body.current, local) : null;
        if (rect) box.scrollTop += rect.top - box.getBoundingClientRect().top - kept.delta;
      }
      width = box.clientWidth;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => report.current());
    });
    observer.observe(box);
    box.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onScroll);
    return () => {
      if (synchronize.current === sync) synchronize.current = null;
      observer.disconnect();
      box.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onScroll);
      cancelAnimationFrame(frame.current);
      if (indicatorTimer.current !== null) clearTimeout(indicatorTimer.current);
    };
  }, [viewport, controller, synchronize]);
  return (
    <div className="relative h-full">
      <div
        ref={viewport}
        data-testid="reader-scroll"
        className="reader-scroll h-full overflow-y-auto overscroll-contain"
        style={{ overflowAnchor: "none" }}
        onWheel={() => {
          onInteract();
          onUserScroll();
        }}
        onTouchStart={onInteract}
        onTouchMove={onUserScroll}
      >
        {/* The single-page text column; .reader-prose resets padding on its own element. */}
        <div
          className="max-w-2xl mx-auto"
          style={{
            paddingLeft: "var(--reader-margin-left, 20px)",
            paddingRight: "var(--reader-margin-right, 20px)",
          }}
        >
          <div
            ref={beforeBody}
            data-testid="reader-scroll-before"
            className={`reader-prose reader-text ${before ? "pb-10" : ""}`}
          />
          <div
            ref={body}
            className="reader-prose reader-text"
            data-testid="reader-scroll-text"
            data-start={content.startOffset}
            data-end={content.endOffset}
            data-total={content.totalLength}
          />
          <div
            ref={afterBody}
            data-testid="reader-scroll-after"
            className={`reader-prose reader-text ${after ? "pt-10" : ""}`}
          />
        </div>
        {!content.hasAfter && !after && (
          <div aria-hidden="true" style={{ height: "calc(100% - 1lh)" }} />
        )}
      </div>
      <div
        ref={indicator}
        aria-hidden="true"
        data-testid="reader-scroll-position"
        className="absolute right-0.5 w-1 h-10 rounded-full bg-on-surface/30 pointer-events-none transition-opacity duration-300"
        style={{ top: 0, opacity: 0 }}
      />
    </div>
  );
}

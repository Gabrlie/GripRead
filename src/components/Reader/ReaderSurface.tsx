import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { PageGestureTracker, type GestureHandlers, type TapZones } from "../../reader/gestures";

export function selectionActive(): boolean {
  return Boolean(window.getSelection()?.toString());
}

export function interactiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input,textarea,select,button,[role="slider"],[contenteditable="true"],[role="dialog"]',
      ),
    )
  );
}

interface ReaderSurfaceProps {
  pageBox: RefObject<HTMLDivElement | null>;
  animationBox: RefObject<HTMLDivElement | null>;
  style: CSSProperties;
  /** False while a panel, exit, or other modal state owns input. */
  acceptsGestures: () => boolean;
  /** Any touch on the page, used to pause automatic reading. */
  onInteract: () => void;
  gestures: GestureHandlers;
  zones?: TapZones;
  children: ReactNode;
  double?: boolean;
  scroll?: boolean;
}

/**
 * The reading surface. A gesture tracker (`reader/gestures.ts`) turns pointer
 * input into Legado's nine tap zones and finger-following page drags; text
 * selection starts when a press is held without moving. The animation
 * overlay is aria-hidden and pointer-transparent.
 */
export function ReaderSurface({
  pageBox,
  animationBox,
  style,
  acceptsGestures,
  onInteract,
  gestures,
  zones,
  children,
  double = false,
  scroll = false,
}: ReaderSurfaceProps) {
  const handlers = useRef(gestures);
  handlers.current = gestures;
  const tracker = useRef<PageGestureTracker | null>(null);
  tracker.current ??= new PageGestureTracker({
    tap: (...args) => handlers.current.tap(...args),
    dragStart: (...args) => handlers.current.dragStart(...args),
    dragMove: (...args) => handlers.current.dragMove(...args),
    dragEnd: (...args) => handlers.current.dragEnd(...args),
  });
  tracker.current.configure({ zones, scroll });

  // A page drag must keep the touch: stop the WebView from scrolling or
  // extending a text selection while the finger moves (needs a non-passive
  // listener, which React's synthetic touch events are not).
  useEffect(() => {
    const box = pageBox.current;
    if (!box) return;
    const guard = (event: TouchEvent) => {
      if (tracker.current?.dragging && event.cancelable) event.preventDefault();
    };
    box.addEventListener("touchmove", guard, { passive: false });
    return () => box.removeEventListener("touchmove", guard);
  }, [pageBox]);

  const local = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  return (
    <div
      // Scroll mode spans the full width so its position indicator sits at the
      // screen edge; ReaderScrollText applies the text column itself.
      className={`absolute inset-0 w-full ${scroll ? "" : `${double ? "max-w-6xl" : "max-w-2xl"} mx-auto px-5 sm:px-8 md:px-12`} pt-safe pb-safe overflow-hidden`}
    >
      <div
        ref={pageBox}
        data-testid="reader-surface"
        className="relative h-full min-h-0 w-full"
        // Paginated pages handle every touch themselves; scroll mode keeps
        // native vertical panning.
        style={{ ...style, touchAction: scroll ? "pan-y" : "none" }}
        onPointerDown={(event) => {
          onInteract();
          if (!event.isPrimary || !acceptsGestures() || interactiveTarget(event.target)) return;
          if (event.pointerType === "mouse" && event.button !== 0) return;
          // Keep receiving moves even when the finger leaves the text node.
          event.currentTarget.setPointerCapture?.(event.pointerId);
          tracker.current?.down(local(event));
        }}
        onPointerMove={(event) => {
          if (!event.isPrimary) return;
          const wasDragging = tracker.current?.dragging;
          tracker.current?.move(local(event));
          // A drag that started over text must not leave a selection behind.
          if (!wasDragging && tracker.current?.dragging) window.getSelection()?.removeAllRanges();
        }}
        onPointerUp={(event) => {
          if (!event.isPrimary) return;
          const rect = event.currentTarget.getBoundingClientRect();
          tracker.current?.up(local(event), rect.width, rect.height, selectionActive());
        }}
        onPointerCancel={() => tracker.current?.cancel()}
      >
        {children}
        <div
          ref={animationBox}
          data-testid="reader-animation"
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none overflow-hidden"
        />
      </div>
    </div>
  );
}

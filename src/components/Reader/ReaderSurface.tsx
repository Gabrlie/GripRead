import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";

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
  onInteract: () => void;
  /** `point` is the touch position within the page box, when a touch turned the page. */
  onTurn: (direction: "next" | "previous", point?: { x: number; y: number }) => void;
  onToggleControls: () => void;
  children: ReactNode;
  double?: boolean;
  scroll?: boolean;
}

/**
 * The reading surface and its gestures: side taps and horizontal swipes turn
 * pages, a center tap toggles controls, and vertical drags or text selection
 * never turn. The animation overlay is aria-hidden and pointer-transparent.
 */
export function ReaderSurface({
  pageBox,
  animationBox,
  style,
  acceptsGestures,
  onInteract,
  onTurn,
  onToggleControls,
  children,
  double = false,
  scroll = false,
}: ReaderSurfaceProps) {
  const pointer = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      // Scroll mode spans the full width so its position indicator sits at the
      // screen edge; ReaderScrollText applies the text column itself.
      className={`absolute inset-0 w-full ${scroll ? "" : `${double ? "max-w-6xl" : "max-w-2xl"} mx-auto px-5 sm:px-8 md:px-12`} pt-safe pb-safe overflow-hidden`}
    >
      <div
        ref={pageBox}
        className="relative h-full min-h-0 w-full"
        // Without this the WebView claims horizontal drags as panning and
        // cancels the pointer, so page swipes never reach pointerup.
        style={{ ...style, touchAction: scroll ? "pan-y" : "none" }}
        onPointerCancel={() => {
          pointer.current = null;
        }}
        onPointerDown={(event) => {
          onInteract();
          pointer.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = pointer.current;
          pointer.current = null;
          if (!start || !acceptsGestures() || selectionActive() || interactiveTarget(event.target))
            return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (Math.abs(dy) > 30) {
            onInteract();
            return;
          }
          if (Math.abs(dx) > 60) {
            if (scroll) return;
            onInteract();
            const box = event.currentTarget.getBoundingClientRect();
            onTurn(dx < 0 ? "next" : "previous", {
              x: start.x - box.left,
              y: start.y - box.top,
            });
            return;
          }
          if (Math.abs(dx) > 5 || Math.abs(dy) > 5) return;
          onInteract();
          const rect = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientX - rect.left) / rect.width;
          const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
          if (!scroll && fraction < 0.2) onTurn("previous", point);
          else if (!scroll && fraction > 0.8) onTurn("next", point);
          else onToggleControls();
        }}
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

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
  onTurn: (direction: "next" | "previous") => void;
  onToggleControls: () => void;
  children: ReactNode;
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
}: ReaderSurfaceProps) {
  const pointer = useRef<{ x: number; y: number } | null>(null);
  return (
    <div className="absolute inset-0 w-full max-w-2xl mx-auto px-5 sm:px-8 md:px-12 pt-safe pb-safe overflow-hidden">
      <div
        ref={pageBox}
        className="relative h-full min-h-0 w-full"
        style={style}
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
            onInteract();
            onTurn(dx < 0 ? "next" : "previous");
            return;
          }
          if (Math.abs(dx) > 5) return;
          onInteract();
          const rect = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientX - rect.left) / rect.width;
          if (fraction < 0.2) onTurn("previous");
          else if (fraction > 0.8) onTurn("next");
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

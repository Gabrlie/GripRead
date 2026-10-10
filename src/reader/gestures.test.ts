import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TAP_ZONES, PageGestureTracker, tapZone } from "./gestures";

function setup(options: { scroll?: boolean; canTurn?: boolean } = {}) {
  let time = 0;
  const handlers = {
    tap: vi.fn(),
    dragStart: vi.fn(() => options.canTurn ?? true),
    dragMove: vi.fn(),
    dragEnd: vi.fn(),
  };
  const tracker = new PageGestureTracker(handlers, {
    scroll: options.scroll,
    now: () => time,
  });
  return { tracker, handlers, advance: (ms: number) => (time += ms) };
}

describe("page gestures", () => {
  it("maps taps through Legado's default nine zones", () => {
    const zone = (x: number, y: number) => tapZone({ x, y }, 300, 900, DEFAULT_TAP_ZONES);
    expect(zone(150, 450)).toBe("menu");
    expect(zone(50, 450)).toBe("previous");
    expect(zone(250, 450)).toBe("next");
    expect(zone(150, 100)).toBe("previous");
    expect(zone(150, 800)).toBe("next");
    expect(zone(250, 100)).toBe("next");
  });

  it("taps within the slop and resolves the zone of the press", () => {
    const { tracker, handlers } = setup();
    tracker.down({ x: 150, y: 450 });
    tracker.move({ x: 155, y: 452 });
    tracker.up({ x: 155, y: 452 }, 300, 900, false);
    expect(handlers.tap).toHaveBeenCalledWith("menu", { x: 150, y: 450 });
    expect(handlers.dragStart).not.toHaveBeenCalled();
  });

  it("fixes the direction once, follows the finger, and cancels on a backward last step", () => {
    const { tracker, handlers } = setup();
    tracker.down({ x: 250, y: 450 });
    tracker.move({ x: 200, y: 455 });
    expect(handlers.dragStart).toHaveBeenCalledWith("next", { x: 250, y: 450 });
    expect(tracker.dragging).toBe(true);
    tracker.move({ x: 120, y: 460 });
    tracker.move({ x: 140, y: 460 });
    tracker.up({ x: 140, y: 460 }, 300, 900, false);
    expect(handlers.dragMove).toHaveBeenCalledTimes(3);
    expect(handlers.dragEnd).toHaveBeenCalledWith(false, { x: 140, y: 460 });
    expect(handlers.tap).not.toHaveBeenCalled();

    tracker.down({ x: 50, y: 450 });
    tracker.move({ x: 120, y: 450 });
    expect(handlers.dragStart).toHaveBeenLastCalledWith("previous", { x: 50, y: 450 });
    tracker.up({ x: 160, y: 450 }, 300, 900, false);
    expect(handlers.dragEnd).toHaveBeenLastCalledWith(true, { x: 160, y: 450 });
  });

  it("leaves held presses, vertical drags, scroll mode, and unavailable pages alone", () => {
    const held = setup();
    held.tracker.down({ x: 150, y: 450 });
    held.advance(800);
    held.tracker.move({ x: 100, y: 450 });
    held.tracker.up({ x: 100, y: 450 }, 300, 900, true);
    expect(held.handlers.dragStart).not.toHaveBeenCalled();
    expect(held.handlers.tap).not.toHaveBeenCalled();

    const vertical = setup();
    vertical.tracker.down({ x: 150, y: 450 });
    vertical.tracker.move({ x: 160, y: 300 });
    expect(vertical.handlers.dragStart).not.toHaveBeenCalled();

    const scroll = setup({ scroll: true });
    scroll.tracker.down({ x: 250, y: 450 });
    scroll.tracker.move({ x: 100, y: 450 });
    expect(scroll.handlers.dragStart).not.toHaveBeenCalled();

    const end = setup({ canTurn: false });
    end.tracker.down({ x: 250, y: 450 });
    end.tracker.move({ x: 100, y: 450 });
    end.tracker.up({ x: 100, y: 450 }, 300, 900, false);
    expect(end.handlers.dragEnd).not.toHaveBeenCalled();
    expect(end.tracker.dragging).toBe(false);
  });

  it("ends an interrupted drag without committing it", () => {
    const { tracker, handlers } = setup();
    tracker.down({ x: 250, y: 450 });
    tracker.move({ x: 150, y: 450 });
    tracker.cancel();
    expect(handlers.dragEnd).toHaveBeenCalledWith(false, { x: 150, y: 450 });
  });
});

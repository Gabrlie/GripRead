/**
 * Canvas page curl ("仿真"), ported from Legado's SimulationPageDelegate at
 * tag 3.26.7 (itself derived from the classic Android PageWidget). Both pages
 * are rasterized once per turn; each frame only composites those bitmaps with
 * clip paths, a mirrored back side, and gradient shadows, so the DOM is never
 * touched while the curl moves.
 */

export interface Point {
  x: number;
  y: number;
}

export interface CurlGeometry {
  touch: Point;
  corner: Point;
  control1: Point;
  control2: Point;
  start1: Point;
  start2: Point;
  end1: Point;
  end2: Point;
  vertex1: Point;
  vertex2: Point;
  /** Distance from the folded corner to the touch point. */
  touchToCorner: number;
}

/** Intersection of line p1p2 with line p3p4. */
function cross(p1: Point, p2: Point, p3: Point, p4: Point): Point {
  const a1 = (p2.y - p1.y) / (p2.x - p1.x);
  const b1 = (p1.x * p2.y - p2.x * p1.y) / (p1.x - p2.x);
  const a2 = (p4.y - p3.y) / (p4.x - p3.x);
  const b2 = (p3.x * p4.y - p4.x * p3.y) / (p3.x - p4.x);
  const x = (b2 - b1) / (a1 - a2);
  return { x, y: a1 * x + b1 };
}

function controls(touch: Point, corner: Point) {
  const middle = { x: (touch.x + corner.x) / 2, y: (touch.y + corner.y) / 2 };
  const control1 = {
    x: middle.x - ((corner.y - middle.y) * (corner.y - middle.y)) / (corner.x - middle.x),
    y: corner.y,
  };
  const dy = corner.y - middle.y;
  const control2 = {
    x: corner.x,
    y: middle.y - ((corner.x - middle.x) * (corner.x - middle.x)) / (dy === 0 ? 0.1 : dy),
  };
  return { control1, control2 };
}

/**
 * Computes the curl for a touch point. A touch exactly on the corner or on
 * its horizontal line is nudged, as in Legado, so no division is by zero.
 */
export function curlGeometry(touchPoint: Point, corner: Point, width: number): CurlGeometry {
  const touch = {
    x:
      Math.abs(touchPoint.x - corner.x) < 0.1
        ? corner.x - 0.1 * Math.sign(corner.x || 1)
        : touchPoint.x,
    y:
      Math.abs(touchPoint.y - corner.y) < 0.1
        ? corner.y + (corner.y > 0 ? -0.1 : 0.1)
        : touchPoint.y,
  };
  let { control1, control2 } = controls(touch, corner);
  let start1 = { x: control1.x - (corner.x - control1.x) / 2, y: corner.y };
  // Keep the fold inside the page: shorten the touch vector proportionally.
  if (touch.x > 0 && touch.x < width && (start1.x < 0 || start1.x > width)) {
    if (start1.x < 0) start1.x = width - start1.x;
    const f1 = Math.abs(corner.x - touch.x);
    const f2 = (width * f1) / start1.x;
    touch.x = Math.abs(corner.x - f2);
    const f3 = (Math.abs(corner.x - touch.x) * Math.abs(corner.y - touch.y)) / f1;
    touch.y = Math.abs(corner.y - f3);
    ({ control1, control2 } = controls(touch, corner));
    start1 = { x: control1.x - (corner.x - control1.x) / 2, y: corner.y };
  }
  const start2 = { x: corner.x, y: control2.y - (corner.y - control2.y) / 2 };
  const end1 = cross(touch, control1, start1, start2);
  const end2 = cross(touch, control2, start1, start2);
  return {
    touch,
    corner,
    control1,
    control2,
    start1,
    start2,
    end1,
    end2,
    vertex1: {
      x: (start1.x + 2 * control1.x + end1.x) / 4,
      y: (2 * control1.y + start1.y + end1.y) / 4,
    },
    vertex2: {
      x: (start2.x + 2 * control2.x + end2.x) / 4,
      y: (2 * control2.y + start2.y + end2.y) / 4,
    },
    touchToCorner: Math.hypot(touch.x - corner.x, touch.y - corner.y),
  };
}

/** The region of the turning page that has lifted off (Legado's mPath0). */
function curlPath(g: CurlGeometry): Path2D {
  const path = new Path2D();
  path.moveTo(g.start1.x, g.start1.y);
  path.quadraticCurveTo(g.control1.x, g.control1.y, g.end1.x, g.end1.y);
  path.lineTo(g.touch.x, g.touch.y);
  path.lineTo(g.end2.x, g.end2.y);
  path.quadraticCurveTo(g.control2.x, g.control2.y, g.start2.x, g.start2.y);
  path.lineTo(g.corner.x, g.corner.y);
  path.closePath();
  return path;
}

/** The part of the next page uncovered behind the fold (Legado's mPath1). */
function revealPath(g: CurlGeometry): Path2D {
  const path = new Path2D();
  path.moveTo(g.start1.x, g.start1.y);
  path.lineTo(g.vertex1.x, g.vertex1.y);
  path.lineTo(g.vertex2.x, g.vertex2.y);
  path.lineTo(g.start2.x, g.start2.y);
  path.lineTo(g.corner.x, g.corner.y);
  path.closePath();
  return path;
}

/** The folded-over back of the turning page. */
function backPath(g: CurlGeometry): Path2D {
  const path = new Path2D();
  path.moveTo(g.vertex2.x, g.vertex2.y);
  path.lineTo(g.vertex1.x, g.vertex1.y);
  path.lineTo(g.end1.x, g.end1.y);
  path.lineTo(g.touch.x, g.touch.y);
  path.lineTo(g.end2.x, g.end2.y);
  path.closePath();
  return path;
}

export interface CurlFrame {
  /** The page being turned away (forward) or being laid down (backward). */
  current: CanvasImageSource;
  /** The page revealed beneath it. */
  next: CanvasImageSource;
  background: string;
  width: number;
  height: number;
}

/** Draws one curl frame in CSS pixels; the caller scales for device pixels. */
export function drawCurl(context: CanvasRenderingContext2D, frame: CurlFrame, g: CurlGeometry) {
  const { width, height } = frame;
  const full = new Path2D();
  full.rect(0, 0, width, height);
  const lifted = curlPath(g);
  context.clearRect(0, 0, width, height);

  // Current page outside the lifted region.
  context.save();
  const outside = new Path2D(full);
  outside.addPath(lifted);
  context.clip(outside, "evenodd");
  context.drawImage(frame.current, 0, 0, width, height);
  context.restore();

  // Next page inside the lifted region, with a shadow along the fold.
  const degrees = Math.atan2(g.control1.x - g.corner.x, g.control2.y - g.corner.y);
  context.save();
  context.clip(lifted);
  context.clip(revealPath(g));
  context.drawImage(frame.next, 0, 0, width, height);
  context.translate(g.start1.x, g.start1.y);
  context.rotate(-degrees);
  const reach = g.touchToCorner / 4;
  const leftward = g.corner.x > 0;
  const shadow = context.createLinearGradient(0, 0, leftward ? -reach : reach, 0);
  shadow.addColorStop(0, "rgba(0,0,0,0.28)");
  shadow.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = shadow;
  context.fillRect(leftward ? -reach : 0, -height * 2, reach, height * 4);
  context.restore();

  // Back of the current page: the same bitmap mirrored across the fold line.
  const distance = Math.hypot(g.corner.x - g.control1.x, g.control2.y - g.corner.y);
  if (distance > 0) {
    const f8 = (g.corner.x - g.control1.x) / distance;
    const f9 = (g.control2.y - g.corner.y) / distance;
    context.save();
    context.clip(lifted);
    context.clip(backPath(g));
    context.fillStyle = frame.background;
    context.fillRect(0, 0, width, height);
    context.translate(g.control1.x, g.control1.y);
    context.transform(1 - 2 * f9 * f9, 2 * f8 * f9, 2 * f8 * f9, 1 - 2 * f8 * f8, 0, 0);
    context.translate(-g.control1.x, -g.control1.y);
    context.globalAlpha = 0.28;
    context.drawImage(frame.current, 0, 0, width, height);
    context.restore();

    // Fold shading on the back side.
    context.save();
    context.clip(lifted);
    context.clip(backPath(g));
    const middle = { x: (g.start1.x + g.control1.x) / 2, y: (g.start2.y + g.control2.y) / 2 };
    const depth = Math.max(
      8,
      Math.min(Math.abs(middle.x - g.control1.x), Math.abs(middle.y - g.control2.y)),
    );
    context.translate(g.start1.x, g.start1.y);
    context.rotate(-degrees);
    const fold = context.createLinearGradient(leftward ? 0 : 0, 0, leftward ? depth : -depth, 0);
    fold.addColorStop(0, "rgba(0,0,0,0.18)");
    fold.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = fold;
    context.fillRect(leftward ? 0 : -depth, -height * 2, depth, height * 4);
    context.restore();
  }
}

/**
 * Rasterizes rendered reader text into a canvas at device resolution. Each
 * character is drawn at its laid-out position, so justification, indents,
 * and paragraph gaps match the DOM page exactly.
 */
export function rasterizePage(
  element: HTMLElement,
  origin: DOMRect,
  pixelRatio: number,
  /** A loaded reading background image, drawn to cover the page like CSS `cover`. */
  backgroundImage?: HTMLImageElement | null,
): HTMLCanvasElement {
  const document = element.ownerDocument;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(origin.width * pixelRatio));
  canvas.height = Math.max(1, Math.round(origin.height * pixelRatio));
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.scale(pixelRatio, pixelRatio);
  const view = document.defaultView;
  const style = view?.getComputedStyle(element);
  context.fillStyle = opaque(style?.backgroundColor) ?? "#ffffff";
  context.fillRect(0, 0, origin.width, origin.height);
  if (backgroundImage && backgroundImage.naturalWidth > 0) {
    const scale = Math.max(
      origin.width / backgroundImage.naturalWidth,
      origin.height / backgroundImage.naturalHeight,
    );
    const width = backgroundImage.naturalWidth * scale;
    const height = backgroundImage.naturalHeight * scale;
    context.drawImage(
      backgroundImage,
      (origin.width - width) / 2,
      (origin.height - height) / 2,
      width,
      height,
    );
  }
  context.textBaseline = "alphabetic";
  // Combined opacity of an element and its ancestors inside the copy.
  const alphas = new Map<Element, number>();
  const alphaOf = (node: Element | null): number => {
    if (!node || node === element.parentElement) return 1;
    const known = alphas.get(node);
    if (known !== undefined) return known;
    const own = Number(view?.getComputedStyle(node).opacity ?? 1);
    const value = (Number.isFinite(own) ? own : 1) * alphaOf(node.parentElement);
    alphas.set(node, value);
    return value;
  };
  // Divider lines (border-top/bottom) such as those of the header and footer.
  for (const box of element.querySelectorAll<HTMLElement>("*")) {
    const boxStyle = view?.getComputedStyle(box);
    if (!boxStyle) continue;
    const top = parseFloat(boxStyle.borderTopWidth) || 0;
    const bottom = parseFloat(boxStyle.borderBottomWidth) || 0;
    if (top <= 0 && bottom <= 0) continue;
    const rect = box.getBoundingClientRect();
    context.globalAlpha = alphaOf(box);
    if (top > 0 && boxStyle.borderTopStyle !== "none") {
      context.fillStyle = boxStyle.borderTopColor;
      context.fillRect(rect.left - origin.left, rect.top - origin.top, rect.width, top);
    }
    if (bottom > 0 && boxStyle.borderBottomStyle !== "none") {
      context.fillStyle = boxStyle.borderBottomColor;
      context.fillRect(
        rect.left - origin.left,
        rect.bottom - origin.top - bottom,
        rect.width,
        bottom,
      );
    }
  }
  context.globalAlpha = 1;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const metrics = new Map<string, { ascent: number; descent: number }>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.hidden) continue;
    const text = node.textContent ?? "";
    const parentStyle = view?.getComputedStyle(parent);
    const font = parentStyle ? fontOf(parentStyle) : "16px serif";
    context.font = font;
    context.fillStyle = parentStyle?.color ?? "#000000";
    context.globalAlpha = alphaOf(parent);
    let fontMetrics = metrics.get(font);
    if (!fontMetrics) {
      const measured = context.measureText("国");
      fontMetrics = {
        ascent: measured.fontBoundingBoxAscent ?? measured.actualBoundingBoxAscent ?? 0,
        descent: measured.fontBoundingBoxDescent ?? measured.actualBoundingBoxDescent ?? 0,
      };
      metrics.set(font, fontMetrics);
    }
    let offset = 0;
    for (const character of text) {
      const start = offset;
      offset += character.length;
      if (/\s/u.test(character)) continue;
      range.setStart(node, start);
      range.setEnd(node, offset);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0) continue;
      const lineHeight = rect.height;
      const baseline =
        rect.top -
        origin.top +
        (lineHeight - (fontMetrics.ascent + fontMetrics.descent)) / 2 +
        fontMetrics.ascent;
      context.fillText(character, rect.left - origin.left, baseline);
    }
  }
  range.detach?.();
  context.globalAlpha = 1;
  return canvas;
}

function fontOf(style: CSSStyleDeclaration): string {
  if (style.font) return style.font;
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

/** Transparent page backgrounds fall back to the canvas default. */
function opaque(color: string | undefined): string | null {
  if (!color || color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color)) return null;
  return color;
}

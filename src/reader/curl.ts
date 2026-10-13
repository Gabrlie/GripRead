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

type Orientation = "left-right" | "right-left" | "top-bottom" | "bottom-top";

/** Android's GradientDrawable: `from` at the side the orientation starts on. */
function gradientRect(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  right: number,
  bottom: number,
  orientation: Orientation,
  from: string,
  to: string,
) {
  const [x0, y0, x1, y1] =
    orientation === "left-right"
      ? [left, 0, right, 0]
      : orientation === "right-left"
        ? [right, 0, left, 0]
        : orientation === "top-bottom"
          ? [0, top, 0, bottom]
          : [0, bottom, 0, top];
  const gradient = context.createLinearGradient(x0, y0, x1, y1);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  context.fillStyle = gradient;
  context.fillRect(
    Math.min(left, right),
    Math.min(top, bottom),
    Math.abs(right - left),
    Math.abs(bottom - top),
  );
}

/** Android's `canvas.rotate(degrees, px, py)`. */
function rotateAt(context: CanvasRenderingContext2D, degrees: number, x: number, y: number) {
  context.translate(x, y);
  context.rotate((degrees * Math.PI) / 180);
  context.translate(-x, -y);
}

const toDegrees = (radians: number) => (radians * 180) / Math.PI;

// Legado's shadow colors (0xAARRGGBB): the next page's edge, the lifted
// page's outline, and the fold on its back.
const BACK_SHADOW = ["rgba(17,17,17,0.6)", "rgba(17,17,17,0)"] as const;
const FRONT_SHADOW = ["rgba(17,17,17,0.5)", "rgba(17,17,17,0)"] as const;
const FOLDER_SHADOW = ["rgba(51,51,51,0)", "rgba(51,51,51,0.69)"] as const;
/** Width of the lifted page's outline shadow, as in Legado. */
const FRONT_WIDTH = 25;

/** Draws one curl frame in CSS pixels; the caller scales for device pixels. */
export function drawCurl(context: CanvasRenderingContext2D, frame: CurlFrame, g: CurlGeometry) {
  const { width, height } = frame;
  const maxLength = Math.hypot(width, height);
  const full = new Path2D();
  full.rect(0, 0, width, height);
  const lifted = curlPath(g);
  const outside = new Path2D(full);
  outside.addPath(lifted);
  // The top-right and bottom-left corners mirror the other two.
  const rtOrLb =
    (g.corner.x === 0 && g.corner.y === height) || (g.corner.x === width && g.corner.y === 0);
  context.clearRect(0, 0, width, height);

  // Current page outside the lifted region.
  context.save();
  context.clip(outside, "evenodd");
  context.drawImage(frame.current, 0, 0, width, height);
  context.restore();

  // Next page inside the lifted region, with a shadow along the fold.
  const degrees = toDegrees(Math.atan2(g.control1.x - g.corner.x, g.control2.y - g.corner.y));
  context.save();
  context.clip(lifted);
  context.clip(revealPath(g));
  context.drawImage(frame.next, 0, 0, width, height);
  rotateAt(context, degrees, g.start1.x, g.start1.y);
  const reach = g.touchToCorner / 4;
  gradientRect(
    context,
    rtOrLb ? g.start1.x : g.start1.x - reach,
    g.start1.y,
    rtOrLb ? g.start1.x + reach : g.start1.x,
    g.start1.y + maxLength,
    rtOrLb ? "left-right" : "right-left",
    ...BACK_SHADOW,
  );
  context.restore();

  drawFrontShadow(context, g, outside, rtOrLb, maxLength, height);

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
    context.save();
    context.translate(g.control1.x, g.control1.y);
    context.transform(1 - 2 * f9 * f9, 2 * f8 * f9, 2 * f8 * f9, 1 - 2 * f8 * f8, 0, 0);
    context.translate(-g.control1.x, -g.control1.y);
    context.globalAlpha = 0.28;
    context.drawImage(frame.current, 0, 0, width, height);
    context.restore();
    // Fold shading on the back side.
    const fold = Math.min(
      Math.abs((g.start1.x + g.control1.x) / 2 - g.control1.x),
      Math.abs((g.start2.y + g.control2.y) / 2 - g.control2.y),
    );
    rotateAt(context, degrees, g.start1.x, g.start1.y);
    gradientRect(
      context,
      rtOrLb ? g.start1.x - 1 : g.start1.x - fold - 1,
      g.start1.y,
      rtOrLb ? g.start1.x + fold + 1 : g.start1.x + 1,
      g.start1.y + maxLength,
      rtOrLb ? "left-right" : "right-left",
      ...FOLDER_SHADOW,
    );
    context.restore();
  }
}

/**
 * The shadow the lifted page casts on the current page along its two
 * outer edges, from the touch point to each bezier control point
 * (Legado's drawCurrentPageShadow).
 */
function drawFrontShadow(
  context: CanvasRenderingContext2D,
  g: CurlGeometry,
  outside: Path2D,
  rtOrLb: boolean,
  maxLength: number,
  height: number,
) {
  const angle = rtOrLb
    ? Math.PI / 4 - Math.atan2(g.control1.y - g.touch.y, g.touch.x - g.control1.x)
    : Math.PI / 4 - Math.atan2(g.touch.y - g.control1.y, g.touch.x - g.control1.x);
  const d1 = FRONT_WIDTH * Math.SQRT2 * Math.cos(angle);
  const d2 = FRONT_WIDTH * Math.SQRT2 * Math.sin(angle);
  const tip = { x: g.touch.x + d1, y: rtOrLb ? g.touch.y + d2 : g.touch.y - d2 };
  const edge = (control: Point, start: Point) => {
    const path = new Path2D();
    path.moveTo(tip.x, tip.y);
    path.lineTo(g.touch.x, g.touch.y);
    path.lineTo(control.x, control.y);
    path.lineTo(start.x, start.y);
    path.closePath();
    return path;
  };

  context.save();
  context.clip(outside, "evenodd");
  context.clip(edge(g.control1, g.start1));
  rotateAt(
    context,
    toDegrees(Math.atan2(g.touch.x - g.control1.x, g.control1.y - g.touch.y)),
    g.control1.x,
    g.control1.y,
  );
  gradientRect(
    context,
    rtOrLb ? g.control1.x : g.control1.x - FRONT_WIDTH,
    g.control1.y - maxLength,
    rtOrLb ? g.control1.x + FRONT_WIDTH : g.control1.x + 1,
    g.control1.y,
    rtOrLb ? "left-right" : "right-left",
    ...FRONT_SHADOW,
  );
  context.restore();

  context.save();
  context.clip(outside, "evenodd");
  context.clip(edge(g.control2, g.start2));
  rotateAt(
    context,
    toDegrees(Math.atan2(g.control2.y - g.touch.y, g.control2.x - g.touch.x)),
    g.control2.x,
    g.control2.y,
  );
  const top = rtOrLb ? g.control2.y : g.control2.y - FRONT_WIDTH;
  const bottom = rtOrLb ? g.control2.y + FRONT_WIDTH : g.control2.y + 1;
  const reach = Math.hypot(g.control2.x, g.control2.y < 0 ? g.control2.y - height : g.control2.y);
  const [left, right] =
    reach > maxLength
      ? [g.control2.x - FRONT_WIDTH - reach, g.control2.x + maxLength - reach]
      : [g.control2.x - maxLength, g.control2.x];
  gradientRect(
    context,
    left,
    top,
    right,
    bottom,
    rtOrLb ? "top-bottom" : "bottom-top",
    ...FRONT_SHADOW,
  );
  context.restore();
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
  // Lines are told apart by their paragraph and top, so a line split into
  // several text nodes (a highlight) is placed as one.
  const blocks = new Map<Element, number>();
  const glyphs: (LaidGlyph & {
    font: string;
    color: string;
    alpha: number;
    ascent: number;
    descent: number;
  })[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.hidden) continue;
    const text = node.textContent ?? "";
    const parentStyle = view?.getComputedStyle(parent);
    const font = parentStyle ? fontOf(parentStyle) : "16px serif";
    context.font = font;
    let fontMetrics = metrics.get(font);
    if (!fontMetrics) {
      const measured = context.measureText("国");
      fontMetrics = {
        ascent: measured.fontBoundingBoxAscent ?? measured.actualBoundingBoxAscent ?? 0,
        descent: measured.fontBoundingBoxDescent ?? measured.actualBoundingBoxDescent ?? 0,
      };
      metrics.set(font, fontMetrics);
    }
    const block = parent.closest(".reader-paragraph") ?? parent;
    if (!blocks.has(block)) blocks.set(block, blocks.size);
    const shared = {
      font,
      color: parentStyle?.color ?? "#000000",
      alpha: alphaOf(parent),
      ascent: fontMetrics.ascent,
      descent: fontMetrics.descent,
      spacing: parseFloat(parentStyle?.letterSpacing ?? "") || 0,
      tabular: parentStyle?.fontVariantNumeric.includes("tabular-nums") ?? false,
    };
    let offset = 0;
    for (const character of text) {
      const start = offset;
      offset += character.length;
      if (/\s/u.test(character)) continue;
      range.setStart(node, start);
      range.setEnd(node, offset);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0) continue;
      glyphs.push({
        ...shared,
        character,
        line: `${blocks.get(block)}:${Math.round(rect.top)}`,
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
        advance: context.measureText(character).width,
      });
    }
  }
  const lefts = glyphLefts(glyphs);
  glyphs.forEach((glyph, index) => {
    context.font = glyph.font;
    context.fillStyle = glyph.color;
    context.globalAlpha = glyph.alpha;
    const baseline = glyph.top + (glyph.height - (glyph.ascent + glyph.descent)) / 2 + glyph.ascent;
    context.fillText(glyph.character, lefts[index], baseline);
  });
  range.detach?.();
  context.globalAlpha = 1;
  return canvas;
}

/** A character's box as laid out, relative to the page. */
export interface LaidGlyph {
  character: string;
  /** Glyphs with the same key share a line. */
  line: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** The plain glyph's width on the canvas. */
  advance: number;
  /** CSS letter-spacing in pixels. */
  spacing: number;
  tabular: boolean;
}

/** Characters a justified line can widen around (CJK ideographs, kana, full-width marks). */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;

/**
 * Where each glyph starts. Justification widens a box after its glyph,
 * and also before a wide character that follows a narrow one (a curly
 * quote, a Latin letter), so such a glyph sits that much inside its box.
 * A line's usual widening is the smallest among its wide characters
 * (compressed punctuation aside); anything beyond it is space in front,
 * and the line's last character has none after it.
 */
export function glyphLefts(glyphs: readonly LaidGlyph[]): number[] {
  const lines = new Map<string, number[]>();
  glyphs.forEach((glyph, index) => {
    const line = lines.get(glyph.line);
    if (line) line.push(index);
    else lines.set(glyph.line, [index]);
  });
  const lefts = glyphs.map((glyph) =>
    glyphLeft(glyph.character, glyph.left, glyph.width, glyph.advance, glyph.tabular),
  );
  const extra = (glyph: LaidGlyph) => glyph.width - glyph.advance - glyph.spacing;
  for (const line of lines.values()) {
    const first = line[0];
    const last = line[line.length - 1];
    const wide = line.filter((index) => WIDE.test(glyphs[index].character));
    const widenings = wide
      .filter((index) => index !== last)
      .map((index) => extra(glyphs[index]))
      .filter((value) => value > -0.5);
    if (!widenings.length) continue;
    const usual = Math.max(0, Math.min(...widenings));
    for (const index of wide) {
      if (index === first) continue;
      const before = extra(glyphs[index]) - (index === last ? 0 : usual);
      if (before > 0.5) lefts[index] = glyphs[index].left + before;
    }
  }
  return lefts;
}

/** Opening CJK punctuation; the browser trims its leading half when compressed. */
const OPENING = /^[「『（《〈【〔〖〘〚｛［“‘(\[{]$/u;

/**
 * Where a glyph starts inside its laid-out box. Canvas cannot apply CSS font
 * features, so a box can differ from the plain glyph: tabular digits are
 * centered in their fixed width, and compressed punctuation keeps the side
 * the browser kept (the right half of opening marks, the left of others).
 */
export function glyphLeft(
  character: string,
  left: number,
  box: number,
  advance: number,
  tabular: boolean,
): number {
  if (advance < box && tabular && /^\d$/u.test(character)) return left + (box - advance) / 2;
  if (advance > box + 0.5 && OPENING.test(character)) return left + box - advance;
  return left;
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

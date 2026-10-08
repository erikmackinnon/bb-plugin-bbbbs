/**
 * Terminal-only zoom and fit, independent of bb's app zoom.
 *
 * Sizes are xterm `fontSize` values in CSS pixels. The VGA font's cell is
 * half as wide as it is tall (8×16 at 16px), so an 80×25 grid at size `f` is
 * `40f × 25f` pixels.
 */

/** The user's zoom choice: fit the pane, or a fixed xterm fontSize. */
export type ZoomSetting = "fit" | number;

/** Zoom ladder for A− / A+. Multiples of 16 are pixel-perfect. */
export const ZOOM_STEPS: readonly number[] = [10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96];
export const MIN_ZOOM = ZOOM_STEPS[0]!;
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/** Persisted form: 0 means fit, otherwise a fontSize on the ladder's range. */
export function zoomFromStored(value: unknown): ZoomSetting {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_ZOOM && value <= MAX_ZOOM ? Math.round(value) : "fit";
}
export function zoomToStored(zoom: ZoomSetting): number {
  return zoom === "fit" ? 0 : zoom;
}

export interface FitOptions {
  cols?: number;
  rows?: number;
  /** Accept a crisp multiple of 16 if it uses at least this share of the space. Default 0.9. */
  crispShare?: number;
  /** Smallest fontSize to render at; below it the grid is scaled down. Default 10. */
  minFont?: number;
}

export interface GridLayout {
  /** fontSize to give xterm. */
  fontSize: number;
  /**
   * CSS scale for the rendered grid, applied after measuring xterm's real
   * screen size: `null` means "scale to fill the box" (smooth fit), a number
   * is used as-is (1 = pixel-perfect).
   */
  scale: number | null;
  /** True when the grid is drawn at an integer multiple of the 8×16 cell. */
  crisp: boolean;
}

/** The largest 80×25 fontSize that fits `width × height` (fractional). */
export function maxFontFor(width: number, height: number, cols = 80, rows = 25): number {
  return Math.max(0, Math.min((width * 2) / cols, height / rows));
}

/**
 * Fit the grid into a box as large as possible in both dimensions. Prefers a
 * pixel-perfect multiple of the 8×16 cell when it wastes little space,
 * otherwise renders at the nearest whole font size and scales smoothly to
 * fill the remaining fraction exactly.
 */
export function fitLayout(width: number, height: number, options: FitOptions = {}): GridLayout {
  const { cols = 80, rows = 25, crispShare = 0.9, minFont = 10 } = options;
  const max = maxFontFor(width, height, cols, rows);
  const crisp = Math.floor(max / 16) * 16;
  if (crisp >= 16 && crisp >= max * crispShare) return { fontSize: crisp, scale: 1, crisp: true };
  return { fontSize: Math.max(minFont, Math.floor(max)), scale: null, crisp: false };
}

/** Layout for a fixed zoom: render at that size, never rescale. */
export function fixedLayout(fontSize: number): GridLayout {
  const size = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(fontSize)));
  return { fontSize: size, scale: 1, crisp: size % 16 === 0 };
}

/**
 * Next zoom step from what is on screen now (`effective` = fontSize × scale),
 * so A+ from Fit always grows and A− always shrinks.
 */
export function stepZoom(effective: number, direction: "in" | "out"): number {
  if (direction === "in") return ZOOM_STEPS.find((step) => step > effective * 1.02) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < effective * 0.98) ?? MIN_ZOOM;
}

export type ZoomCommand = "in" | "out" | "fit";

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}

/**
 * Terminal zoom chords.
 * - Ctrl/Cmd + `+` `=` / `-` / `0`: the familiar ones. bb's desktop app binds
 *   the same keys to app zoom, so the page must claim them in the capture
 *   phase with preventDefault.
 * - Alt/Option + `=` / `-` / `0` (by physical key): a fallback that never
 *   collides with app or browser zoom.
 */
export function zoomCommandForKey(event: KeyLike): ZoomCommand | null {
  const code = event.code ?? "";
  const primary = (event.ctrlKey || event.metaKey) && !event.altKey;
  const fallback = event.altKey && !event.ctrlKey && !event.metaKey;
  if (!primary && !fallback) return null;
  const k = event.key;
  if (code === "Equal" || code === "NumpadAdd" || (primary && (k === "=" || k === "+"))) return "in";
  if (code === "Minus" || code === "NumpadSubtract" || (primary && (k === "-" || k === "_"))) return "out";
  if (code === "Digit0" || code === "Numpad0" || (primary && k === "0")) return "fit";
  return null;
}

/** Human-readable chords for tooltips, per platform. */
export function zoomShortcutLabels(isMac: boolean) {
  const mod = isMac ? "⌘" : "Ctrl+";
  const alt = isMac ? "⌥" : "Alt+";
  return {
    in: `${mod}+ or ${alt}=`,
    out: `${mod}− or ${alt}−`,
    fit: `${mod}0 or ${alt}0`,
    wheel: `${mod}scroll`,
  };
}

/**
 * Turns Ctrl/Cmd+wheel (and trackpad pinch, which arrives as ctrl+wheel with
 * small deltas) into discrete zoom steps.
 */
export function createWheelZoom(threshold = 60) {
  let acc = 0;
  return (deltaY: number, deltaMode = 0): "in" | "out" | null => {
    acc += deltaMode === 1 ? deltaY * 20 : deltaMode === 2 ? deltaY * 400 : deltaY;
    if (Math.abs(acc) < threshold) return null;
    const direction = acc < 0 ? "in" : "out";
    acc = 0;
    return direction;
  };
}

export interface ScrollBox {
  scrollLeft: number;
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Minimal scroll that brings `target` (plus `margin` pixels around it) into
 * view. Returns the new scroll position; unchanged if already visible.
 */
export function scrollToReveal(box: ScrollBox, target: Rect, margin = 0): { left: number; top: number } {
  const axis = (scroll: number, size: number, start: number, length: number) => {
    const lo = start - margin;
    const hi = start + length + margin;
    if (hi - lo > size) return Math.max(0, start + length / 2 - size / 2); // larger than view: center it
    if (lo < scroll) return Math.max(0, lo);
    if (hi > scroll + size) return hi - size;
    return scroll;
  };
  return {
    left: axis(box.scrollLeft, box.clientWidth, target.x, target.width),
    top: axis(box.scrollTop, box.clientHeight, target.y, target.height),
  };
}

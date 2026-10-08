import { VGA_FONT_WOFF_BASE64 } from "./font-data";

/** CSS font-family name the bundled VGA font is registered under. */
export const BBS_FONT_NAME = "bbbbs PxPlus IBM VGA 8x16";

/** Use this as xterm's fontFamily: the VGA font, then sane monospace fallbacks. */
export const BBS_FONT_FAMILY = `"${BBS_FONT_NAME}", "Px437 IBM VGA 8x16", "PxPlus IBM VGA 8x16", ui-monospace, Menlo, Consolas, monospace`;

/** Native cell size of the font, in CSS pixels at fontSize 16. */
export const FONT_CELL = { width: 8, height: 16 } as const;

let loading: Promise<boolean> | null = null;

/**
 * Registers the bundled VGA font with `document.fonts` and waits until it is
 * usable. Call (and await) this BEFORE `terminal.open()`: xterm.js measures
 * its cell size once at open, and measuring a fallback font gives you a
 * squashed grid.
 *
 * Resolves `true` when the font is ready, `false` if the browser refused it
 * (the terminal still works with the monospace fallback). Never rejects.
 * Safe to call many times.
 */
export function loadBbsFont(): Promise<boolean> {
  if (loading) return loading;
  loading = (async () => {
    if (typeof document === "undefined" || typeof FontFace === "undefined") return false;
    try {
      const bytes = Uint8Array.from(atob(VGA_FONT_WOFF_BASE64), (c) => c.charCodeAt(0));
      const face = new FontFace(BBS_FONT_NAME, bytes.buffer, { style: "normal", weight: "400", display: "block" });
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      loading = null; // allow a retry later
      return false;
    }
  })();
  return loading;
}

/**
 * Picks an xterm fontSize so an 80x25 grid fits in `width` x `height` CSS
 * pixels. Snaps to whole multiples of 16 (integer scaling keeps the bitmap
 * font pixel-perfect); below 16 it shrinks to whatever fits, never below `min`.
 */
export function pickFontSize(width: number, height: number, cols = 80, rows = 25, min = 10): number {
  const fit = Math.floor(Math.min((width / cols) * 2, height / rows));
  return fit >= 16 ? Math.floor(fit / 16) * 16 : Math.max(min, fit);
}

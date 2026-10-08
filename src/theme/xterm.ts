import type { ITerminalInitOnlyOptions, ITerminalOptions, ITheme } from "@xterm/xterm";

/** Everything `new Terminal(options)` accepts. */
export type BbsTerminalOptions = ITerminalOptions & ITerminalInitOnlyOptions;
import { CGA_PALETTE } from "./palette";
import { BBS_FONT_FAMILY } from "./font";

/** xterm.js colour theme: CGA palette on a pure black screen. */
export const xtermTheme: ITheme = {
  ...CGA_PALETTE,
  foreground: CGA_PALETTE.white,
  background: CGA_PALETTE.black,
  cursor: CGA_PALETTE.white,
  cursorAccent: CGA_PALETTE.black,
  // DOS-era "inverse" selection, translucent so the art stays readable
  selectionBackground: "rgba(170, 170, 170, 0.45)",
  selectionInactiveBackground: "rgba(85, 85, 85, 0.45)",
  scrollbarSliderBackground: "rgba(85, 85, 85, 0.35)",
  scrollbarSliderHoverBackground: "rgba(85, 85, 85, 0.6)",
  scrollbarSliderActiveBackground: "rgba(170, 170, 170, 0.6)",
};

/**
 * Options for `new Terminal(...)`. The BBS is a fixed 80x25 board, so the
 * grid is fixed too: scale the font with `pickFontSize()` instead of using
 * the fit addon to change cols/rows.
 *
 * Remember to `await loadBbsFont()` before `terminal.open()`.
 */
export const xtermOptions: BbsTerminalOptions = {
  cols: 80,
  rows: 25,
  fontFamily: BBS_FONT_FAMILY,
  fontSize: 16,
  lineHeight: 1,
  letterSpacing: 0,
  // A bitmap VGA font has no bold. ANSI "bold" means bright colour, which is
  // exactly what drawBoldTextInBrightColors does; never thicken the glyphs.
  fontWeight: "normal",
  fontWeightBold: "normal",
  drawBoldTextInBrightColors: true,
  // xterm draws box/block characters itself so ▀▄█ tile without seams.
  customGlyphs: true,
  // Never "fix" contrast: dark grey on black is a deliberate art choice.
  minimumContrastRatio: 1,
  cursorStyle: "underline", // the DOS blinking underscore
  cursorBlink: true,
  cursorInactiveStyle: "none",
  scrollback: 500,
  allowTransparency: false,
  theme: xtermTheme,
};

/** The same options with blinking turned off, for prefers-reduced-motion. */
export const xtermOptionsReducedMotion: BbsTerminalOptions = { ...xtermOptions, cursorBlink: false };

/** True when the user asked the OS for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

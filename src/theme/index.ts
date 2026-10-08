/**
 * bbBBS theme: everything that makes the terminal look like 1994.
 * Owned by the Design stream; see ./README.md for usage.
 *
 * Also import "./theme.css" once from the plugin stylesheet.
 */
export { CGA_PALETTE, CGA_ANSI, ACCENT, type CgaColorName } from "./palette";
export { BBS_FONT_NAME, BBS_FONT_FAMILY, FONT_CELL, loadBbsFont, pickFontSize } from "./font";
export { xtermTheme, xtermOptions, type BbsTerminalOptions, xtermOptionsReducedMotion, prefersReducedMotion } from "./xterm";
export { playDialSequence, hideCursor, type DialOptions, type DialResult, type TerminalLike } from "./boot";
export { HANGUP_COPY, hangupReasonFrom, noCarrierText, type HangupReason } from "./noCarrier";
export { createModemSound, type ModemSound, type ModemSoundOptions } from "./sound";
export { TAGLINES, pickTagline } from "./taglines";
export { stripAnsi } from "./ansi";
export {
  ZOOM_STEPS, MIN_ZOOM, MAX_ZOOM, zoomFromStored, zoomToStored, maxFontFor, fitLayout, fixedLayout, stepZoom,
  zoomCommandForKey, zoomShortcutLabels, createWheelZoom, scrollToReveal,
  type ZoomSetting, type ZoomCommand, type GridLayout, type FitOptions, type ScrollBox, type Rect,
} from "./zoom";
export { BbsFrame, type BbsFrameProps, type BbsState } from "./BbsFrame";

/** Third-party assets bundled in this module, for an About/credits screen. */
export const THEME_CREDITS = [
  {
    asset: "PxPlus IBM VGA 8x16 (WebPlus_IBM_VGA_8x16.woff)",
    author: "VileR, The Ultimate Oldschool PC Font Pack v2.2",
    url: "https://int10h.org/oldschool-pc-fonts/",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  },
] as const;

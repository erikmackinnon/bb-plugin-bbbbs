/**
 * The 16-colour IBM CGA/EGA/VGA text-mode palette, in ANSI order.
 *
 * These are the real RGBI values (0x00/0x55/0xAA/0xFF), including the famous
 * CGA quirk where "dark yellow" is brown (#AA5500). The BBS's ANSI screens
 * were drawn against exactly these colours.
 */
export const CGA_PALETTE = {
  black: "#000000",
  red: "#aa0000",
  green: "#00aa00",
  yellow: "#aa5500", // brown, as IBM intended
  blue: "#0000aa",
  magenta: "#aa00aa",
  cyan: "#00aaaa",
  white: "#aaaaaa", // "light grey": the default text colour
  brightBlack: "#555555",
  brightRed: "#ff5555",
  brightGreen: "#55ff55",
  brightYellow: "#ffff55",
  brightBlue: "#5555ff",
  brightMagenta: "#ff55ff",
  brightCyan: "#55ffff",
  brightWhite: "#ffffff",
} as const;

export type CgaColorName = keyof typeof CGA_PALETTE;

/** Same colours as an array indexed by ANSI colour number 0-15. */
export const CGA_ANSI: readonly string[] = Object.values(CGA_PALETTE);

/** Accent colours used by the frame chrome (status LED, links). */
export const ACCENT = {
  online: CGA_PALETTE.brightGreen,
  dialing: CGA_PALETTE.brightYellow,
  offline: CGA_PALETTE.brightRed,
  phosphor: CGA_PALETTE.brightCyan,
} as const;

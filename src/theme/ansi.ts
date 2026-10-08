/** Tiny ANSI helpers for writing coloured text into xterm.js. */
const ESC = "\x1b[";

/** SGR for a CGA colour: 0-7 normal, 8-15 bright (bold + base colour). */
export function fg(color: number): string {
  return color >= 8 ? `${ESC}0;1;${30 + color - 8}m` : `${ESC}0;${30 + color}m`;
}

export const RESET = `${ESC}0m`;
export const CLEAR = `${ESC}0m${ESC}2J${ESC}H`;
export const HIDE_CURSOR = `${ESC}?25l`;
export const SHOW_CURSOR = `${ESC}?25h`;
export const CRLF = "\r\n";

/** Colour numbers by name, for readability at call sites. */
export const C = {
  black: 0, red: 1, green: 2, brown: 3, blue: 4, magenta: 5, cyan: 6, grey: 7,
  darkGrey: 8, brightRed: 9, brightGreen: 10, yellow: 11, brightBlue: 12, brightMagenta: 13, brightCyan: 14, white: 15,
} as const;

/** Strips ANSI escape sequences (for agents, tests and aria-live text). */
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

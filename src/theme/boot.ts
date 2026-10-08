import { C, CLEAR, CRLF, HIDE_CURSOR, RESET, SHOW_CURSOR, fg } from "./ansi";
import { createModemSound, type ModemSound } from "./sound";
import { pickTagline } from "./taglines";
import { prefersReducedMotion } from "./xterm";

/** Anything with xterm's `write`. */
export interface TerminalLike {
  write(data: string): void;
}

export interface DialOptions {
  /**
   * Settles when the real connection is up (resolve, e.g. on the gateway's
   * `ready` or `registered`) or has failed (reject). The sequence keeps
   * "RINGING" until it settles, so the animation never delays a fast
   * connection by more than about two seconds.
   */
  connected: Promise<unknown>;
  /** What the modem "dials". Default `bbs.gravytrain.ca`. */
  number?: string;
  /** Aborting stops writing immediately and resolves `{ status: "aborted" }`. */
  signal?: AbortSignal;
  /** Aborting skips the remaining animation (e.g. on any keypress). */
  fastForward?: AbortSignal;
  /** Print everything at once. Defaults to `prefers-reduced-motion`. */
  instant?: boolean;
  /** Synthesised modem noises. Default false. Needs a prior user gesture. */
  sound?: boolean;
  /** Characters per second for "received" text. Default 240 (2400 baud). */
  cps?: number;
  /** Random source for the tagline (tests). */
  random?: () => number;
}

export type DialResult =
  | { status: "connected" }
  | { status: "failed"; error: unknown }
  | { status: "aborted" };

const dim = fg(C.darkGrey);
const text = fg(C.grey);
const hi = fg(C.white);

/**
 * Plays the dial-up boot sequence into the terminal while the real WebSocket
 * connects:
 *
 *   ATZ / OK / ATDT bbs.gravytrain.ca / RINGING ... / CONNECT 2400/ARQ/V42BIS
 *
 * On success the screen is left as-is (Synchronet clears it with the answer
 * screen). On failure it returns the error and prints nothing more: write
 * `noCarrierText(hangupReasonFrom(msg))` yourself, since only you know why.
 */
export async function playDialSequence(term: TerminalLike, opts: DialOptions): Promise<DialResult> {
  const instant = opts.instant ?? prefersReducedMotion();
  const cps = opts.cps ?? 240;
  const number = opts.number ?? "bbs.gravytrain.ca";
  let fast = instant || !!opts.fastForward?.aborted;
  const onFast = () => {
    fast = true;
  };
  opts.fastForward?.addEventListener("abort", onFast, { once: true });

  let settled: DialResult | null = null;
  const settledP = opts.connected.then(
    () => (settled = { status: "connected" }),
    (error: unknown) => (settled = { status: "failed", error }),
  );

  let sound: ModemSound | null = null;
  let rang = false;
  const aborted = () => !!opts.signal?.aborted;

  const sleep = (ms: number) =>
    fast || ms <= 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const t = setTimeout(done, ms);
          function done() {
            clearTimeout(t);
            opts.signal?.removeEventListener("abort", done);
            opts.fastForward?.removeEventListener("abort", done);
            resolve();
          }
          opts.signal?.addEventListener("abort", done, { once: true });
          opts.fastForward?.addEventListener("abort", done, { once: true });
        });

  /** Text arriving over the line, at modem speed. */
  async function receive(s: string) {
    if (fast) return void term.write(s);
    const chunk = Math.max(1, Math.round(cps / 30)); // ~30 writes per second
    for (let i = 0; i < s.length && !aborted(); i += chunk) {
      term.write(s.slice(i, i + chunk));
      await sleep((chunk / cps) * 1000);
      if (fast) return void term.write(s.slice(i + chunk));
    }
  }

  /** Text the "user" types at the modem, at human speed. */
  async function type(s: string) {
    if (fast) return void term.write(s);
    for (const ch of s) {
      if (aborted()) return;
      term.write(ch);
      await sleep(35 + ((ch.charCodeAt(0) * 7) % 40));
    }
  }

  try {
    if (opts.sound) sound = createModemSound();
    term.write(CLEAR + SHOW_CURSOR);
    await receive(
      `${fg(C.brightCyan)}bbBBS terminal ${dim}v0.1  (C) 1994 bbBBS Telecom, Ltd. (Caps Lock sold separately)${CRLF}` +
        `${dim}${pickTagline(opts.random)}${CRLF}${CRLF}` +
        `${text}Hayes-compatible WebSocket modem detected on ${hi}COM1${text}.${CRLF}${CRLF}`,
    );
    for (const [cmd, pause] of [
      ["ATZ", 250],
      ["AT&F E1 V1 X4 M1L1", 200],
    ] as const) {
      if (aborted()) break;
      await type(`${hi}${cmd}`);
      await sleep(pause);
      await receive(`${CRLF}${text}OK${CRLF}`);
    }
    if (aborted()) return { status: "aborted" };

    await type(`${hi}ATDT ${number}`);
    term.write(CRLF);
    await sound?.dial("1800BBBBS");

    // Ring until the real connection settles (at least once, for the drama).
    // In fast mode we print one RINGING and simply wait for the line.
    const abortP = new Promise<void>((resolve) => {
      if (aborted()) resolve();
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    do {
      if (!fast || !rang) await receive(`${text}RINGING${CRLF}`);
      rang = true;
      if (sound && !fast) await sound.ring();
      else await Promise.race([settledP, abortP, fast ? new Promise(() => {}) : sleep(1100)]);
    } while (!settled && !aborted());
    if (aborted()) return { status: "aborted" };

    const result = settled as DialResult | null;
    // On failure print nothing: only the caller knows the reason (BUSY vs
    // NO CARRIER), so it writes noCarrierText(reason) itself.
    if (!result || result.status !== "connected") return result ?? { status: "aborted" };

    const screech = sound && !fast ? sound.handshake() : sleep(900);
    await receive(`${dim}~ eeeeEEEEEE ~ bong ~ bing ~ kkkshhhhhhhhhhhhhhhhh ~${CRLF}`);
    await screech;
    await receive(`${CRLF}${hi}CONNECT 2400/ARQ/V42BIS${RESET}${CRLF}${CRLF}`);
    await sleep(350);
    return { status: "connected" };
  } finally {
    sound?.stop();
    opts.fastForward?.removeEventListener("abort", onFast);
    term.write(RESET);
  }
}

/** Hides the cursor; handy while the frame shows an overlay. */
export const hideCursor = (term: TerminalLike) => term.write(HIDE_CURSOR);

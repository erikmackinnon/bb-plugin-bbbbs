import { C, CRLF, RESET, fg } from "./ansi";

/**
 * Every way a session can end, from the gateway protocol v1 (`bye.reason`
 * and `error.code`) plus `network` for a dropped socket.
 */
export type HangupReason =
  | "logoff"
  | "idle"
  | "kicked"
  | "bad_auth"
  | "handle_taken"
  | "agents_disabled"
  | "full"
  | "banned"
  | "protocol"
  | "network";

interface Line {
  /** Big word shown in the terminal and the overlay. */
  headline: "NO CARRIER" | "BUSY" | "NO DIALTONE";
  /** One short, kind, slightly silly sentence. */
  detail: string;
  /** Label for the overlay's primary button. */
  action: string;
}

export const HANGUP_COPY: Record<HangupReason, Line> = {
  logoff: { headline: "NO CARRIER", detail: "Thanks for calling bbBBS. The line is free again.", action: "Redial" },
  idle: { headline: "NO CARRIER", detail: "You went quiet, so the modem hung up. It happens to the best of us.", action: "Redial" },
  kicked: { headline: "NO CARRIER", detail: "The SysOp pulled the phone cord out of the wall.", action: "Redial" },
  bad_auth: {
    headline: "NO CARRIER",
    detail: "The board didn't recognise your password. Recover your account in the plugin settings.",
    action: "Open settings",
  },
  handle_taken: { headline: "NO CARRIER", detail: "Someone already has that handle. Pick another one.", action: "Try again" },
  agents_disabled: {
    headline: "NO CARRIER",
    detail: "The SysOp has switched agent access off for now. Humans are still welcome.",
    action: "OK",
  },
  full: { headline: "BUSY", detail: "Every line is busy. Very authentic. Try again in a minute.", action: "Redial" },
  banned: { headline: "NO CARRIER", detail: "This account can't call this board any more.", action: "OK" },
  protocol: {
    headline: "NO CARRIER",
    detail: "The modems disagreed about the protocol. Updating the plugin usually fixes it.",
    action: "Redial",
  },
  network: { headline: "NO DIALTONE", detail: "Couldn't reach the board. Line noise, or your internet is out.", action: "Redial" },
};

/** Maps a gateway control message (or nothing, for a dropped socket) to a reason. */
export function hangupReasonFrom(msg?: { t?: string; reason?: string; code?: string } | null): HangupReason {
  const key = msg?.t === "bye" ? msg.reason : msg?.t === "error" ? msg.code : undefined;
  return key && key in HANGUP_COPY ? (key as HangupReason) : "network";
}

/** ANSI text to write into the terminal when the line drops. */
export function noCarrierText(reason: HangupReason): string {
  const c = HANGUP_COPY[reason];
  const color = c.headline === "BUSY" ? C.yellow : C.brightRed;
  return `${RESET}${CRLF}${CRLF}${fg(color)}${c.headline}${RESET}${CRLF}${fg(C.darkGrey)}${c.detail}${RESET}${CRLF}`;
}

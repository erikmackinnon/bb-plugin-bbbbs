import { z } from "zod";
import type { ConnectionState } from "./protocol";

export const browserControlSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("resize"), cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(500) }).strict(),
  z.object({ t: z.literal("reconnect") }).strict(),
  z.object({ t: z.literal("disconnect") }).strict(),
  z.object({ t: z.literal("recovery-saved") }).strict(),
]);

export interface BrowserPeer {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export type BrowserEvent =
  | { t: "state"; state: ConnectionState }
  | { t: "reset" }
  | { t: "recovery"; handle: string; password: string }
  | { t: "recovery-dismissed" }
  /** Proof of a human view for account replacement; sent only on this local-auth socket. */
  | { t: "confirm-token"; token: string };

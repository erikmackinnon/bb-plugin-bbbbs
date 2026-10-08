import type { ConnectionState } from "./protocol";
import { hangupReasonFrom } from "./theme";

/** Translate the backend's safe browser state back to Design's gateway copy. */
export function connectionHangupReason(state: ConnectionState) {
  if (state.status === "error") return hangupReasonFrom({ t: "error", code: state.code });
  if (state.status === "closed") return hangupReasonFrom({ t: "bye", reason: state.code ?? state.message });
  if (state.status === "disconnected" && !state.message) return hangupReasonFrom({ t: "bye", reason: "logoff" });
  return hangupReasonFrom(null);
}

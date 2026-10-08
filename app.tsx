import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { definePluginApp, experimental_usePluginId, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { Terminal } from "@xterm/xterm";
import type { rpcContract } from "./server";
import type { BrowserEvent } from "./src/bridge";
import type { ConnectionState } from "./src/protocol";
import { suppressBrowserTerminalReplies } from "./src/browser-terminal";
import { connectionHangupReason } from "./src/theme-adapter";
import { HANDLE_RULE, HAVE_ACCOUNT, PASSWORD_RULE, REGISTRATION_INTERRUPTED, REGISTRATION_INTERRUPTED_MESSAGE, START_NEW_ACCOUNT_WARNING } from "./src/messages";
import {
  BbsFrame, loadBbsFont, xtermOptions, prefersReducedMotion, playDialSequence, noCarrierText, THEME_CREDITS, type HangupReason,
  fitLayout, fixedLayout, stepZoom, zoomFromStored, zoomToStored, zoomCommandForKey, zoomShortcutLabels, createWheelZoom,
  scrollToReveal, type ZoomSetting, type ZoomCommand,
} from "./src/theme";
import "./src/theme/theme.css";
import "@xterm/xterm/css/xterm.css";
import "./src/app.css";

const recoverErrors = {
  "invalid-handle": `That handle isn't valid. ${HANDLE_RULE}`,
  "invalid-password": `That recovery password isn't valid. ${PASSWORD_RULE}`,
  "unsaved-account": "This bb's new account hasn't had its recovery password saved. If you switch now, that new account becomes unreachable for good.",
  "caller-not-allowed": "Account recovery is only available from bbBBS itself.",
} as const;

// Sent by the backend on the terminal socket; proves an account replacement comes from a person in this app.
let confirmToken: string | undefined;
const OPEN_TERMINAL_TO_CONFIRM = "Open bbBBS in a pane to confirm replacing this bb's new account.";

/** The stored recovery password, on request, so the user can always get back in elsewhere. */
function YourRecoveryPassword() {
  const rpc = useRpc<typeof rpcContract>();
  const [shown, setShown] = useState<{ handle: string; password: string } | null>(null);
  const [message, setMessage] = useState("");
  const show = async () => {
    setMessage("");
    try {
      const result = await rpc.call("recoveryPassword", null);
      if (result.ok) setShown(result);
      else setMessage(result.error === "no-account" ? "No account yet. Open bbBBS to register." : recoverErrors["caller-not-allowed"]);
    } catch { setMessage("Could not load the recovery password. Try again."); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(shown!.password); setMessage("Copied."); } catch { setMessage("Copy failed. Select the password and copy it."); }
  };
  return <div className="bbs-recovery-form">
    <strong>Your recovery password</strong>
    {shown ? <>
      <p>{shown.handle ? <>For <strong>{shown.handle}</strong>. </> : null}Use it with ‘{HAVE_ACCOUNT}’ to log in from another bb.</p>
      <input aria-label="Your recovery password" readOnly value={shown.password} onFocus={(event) => event.target.select()} autoComplete="off" spellCheck={false} />
      <button type="button" onClick={() => void copy()}>Copy</button>
      {" "}<button type="button" onClick={() => { setShown(null); setMessage(""); }}>Hide</button>
    </> : <p><button type="button" onClick={() => void show()}>Show recovery password</button></p>}
    {message && <p role="status">{message}</p>}
  </div>;
}

/** Settings section: see this bb's password, or switch to an existing account. */
function AccountRecovery({ expanded = false }: { expanded?: boolean }) {
  return <><YourRecoveryPassword /><RecoveryForm expanded={expanded} /></>;
}

function RecoveryForm({ expanded = false }: { expanded?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [message, setMessage] = useState("");
  const recover = async (replaceUnsaved = false) => {
    setMessage(""); setConfirmReplace(false);
    if (replaceUnsaved && !confirmToken) { setMessage(OPEN_TERMINAL_TO_CONFIRM); return; }
    setPending(true);
    try {
      const result = await rpc.call("recover", { handle: handle.trim(), password: password.trim(), ...(replaceUnsaved && { replaceUnsaved, confirmToken }) });
      if (result.ok) { setPassword(""); setMessage("Account saved. Reconnect in the terminal to log in."); }
      else if (result.error === "unsaved-account") setConfirmReplace(true);
      else setMessage(recoverErrors[result.error]);
    } catch { setMessage("Could not save the account. Try again."); }
    finally { setPending(false); }
  };
  const edit = (set: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => { set(event.target.value); setConfirmReplace(false); };
  return <details className="bbs-recovery-form" open={expanded || undefined}>
    <summary>{HAVE_ACCOUNT}</summary>
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); void recover(); }}>
      <label>Handle<input value={handle} onChange={edit(setHandle)} required maxLength={20} autoComplete="off" /></label>
      <label>Recovery password<input type="password" value={password} onChange={edit(setPassword)} required maxLength={64} autoComplete="off" spellCheck={false} /></label>
      <button disabled={pending || !handle.trim() || !password.trim()} type="submit">{pending ? "Saving…" : "Recover account"}</button>
      {confirmReplace && <div role="alert">
        <p>{recoverErrors["unsaved-account"]}</p>
        <button type="button" disabled={pending} onClick={() => void recover(true)}>Replace the new account</button>
        {" "}<button type="button" onClick={() => setConfirmReplace(false)}>Cancel</button>
      </div>}
      {message && <p role="status">{message}</p>}
    </form>
  </details>;
}

/** Way out of an interrupted registration: forget this bb's credentials and register afresh. */
function StartNewAccount({ onStarted }: { onStarted: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const start = async () => {
    setPending(true); setMessage("");
    try {
      if (!confirmToken) { setMessage(OPEN_TERMINAL_TO_CONFIRM); return; }
      const result = await rpc.call("startNewAccount", { replaceUnsaved: true, confirmToken });
      if (result.ok) { setConfirming(false); onStarted(); }
      else setMessage(result.error === "caller-not-allowed" ? recoverErrors["caller-not-allowed"] : recoverErrors["unsaved-account"]);
    } catch { setMessage("Could not start a new account. Try again."); }
    finally { setPending(false); }
  };
  if (!confirming) return <button type="button" onClick={() => setConfirming(true)}>Start a new account instead</button>;
  return <div role="alert">
    <p>{START_NEW_ACCOUNT_WARNING}</p>
    <button type="button" disabled={pending} onClick={() => void start()}>{pending ? "Starting…" : "Start a new account"}</button>
    {" "}<button type="button" onClick={() => setConfirming(false)}>Cancel</button>
    {message && <p role="status">{message}</p>}
  </div>;
}

function useAppearance() {
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings();
  const [appearance, setAppearance] = useState({ crt: true, sound: false, zoom: 0 });
  const [error, setError] = useState("");
  const version = useRef(0);
  const writes = useRef(Promise.resolve());
  const pendingWrites = useRef(0);
  const refresh = () => {
    if (pendingWrites.current) return;
    const current = version.current;
    void rpc.call("account").then((account) => {
      if (version.current === current) setAppearance({ crt: account.crt, sound: account.sound, zoom: account.zoom });
    }, () => {});
  };
  useEffect(refresh, [rpc]);
  useRealtime("account-changed", refresh);
  useEffect(() => {
    if (pendingWrites.current) return;
    setAppearance((previous) => ({
      crt: typeof settings.values?.crt === "boolean" ? settings.values.crt : previous.crt,
      sound: typeof settings.values?.sound === "boolean" ? settings.values.sound : previous.sound,
      zoom: typeof settings.values?.zoom === "number" ? settings.values.zoom : previous.zoom,
    }));
  }, [settings.values?.crt, settings.values?.sound, settings.values?.zoom]);
  const update = (patch: { crt?: boolean; sound?: boolean; zoom?: number }) => {
    const current = ++version.current;
    pendingWrites.current++;
    setAppearance((previous) => ({ ...previous, ...patch }));
    setError("");
    writes.current = writes.current.then(async () => {
      let failed = false;
      try {
        const saved = await rpc.call("appearance", patch);
        if (version.current === current) setAppearance(saved);
      } catch {
        failed = true;
        if (version.current === current) setError("Could not save appearance. Try again.");
      } finally {
        pendingWrites.current--;
        if (failed && version.current === current) refresh();
      }
    });
  };
  return { ...appearance, error, update };
}

function BbsAbout() {
  return <div className="bbs-about">
    <p>bbBBS · A personal community BBS for bb users. Caps Lock kicked in halfway through the name; we kept it.</p>
    {THEME_CREDITS.map((credit) => <p key={credit.asset}>
      {credit.asset} by <a href={credit.url} target="_blank" rel="noreferrer">{credit.author}</a>.
      {" "}Licensed under <a href={credit.licenseUrl} target="_blank" rel="noreferrer">{credit.license}</a>; bundled unmodified.
    </p>)}
  </div>;
}

export function BbsTerminal() {
  const pluginId = experimental_usePluginId();
  const appearance = useAppearance();
  const soundRef = useRef(appearance.sound);
  soundRef.current = appearance.sound;
  const container = useRef<HTMLDivElement>(null); // scrolling viewport
  const stageBox = useRef<HTMLDivElement>(null); // layout box of the scaled grid
  const stage = useRef<HTMLDivElement>(null); // xterm host, CSS-scaled
  const frameRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomSetting>(zoomFromStored(appearance.zoom));
  zoomRef.current = zoomFromStored(appearance.zoom);
  const effectiveRef = useRef(16); // fontSize × scale currently on screen
  const fitRef = useRef<() => void>(() => {});
  const [fullscreen, setFullscreen] = useState(false);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const disconnectRef = useRef<() => void>(() => {});
  const [state, setState] = useState<ConnectionState>({ status: "connecting" });
  const [dialing, setDialing] = useState(true);
  const [hangup, setHangup] = useState<HangupReason | null>(null);
  const [fontSize, setFontSize] = useState(16);
  const [recovery, setRecovery] = useState<{ handle: string; password: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    let alive = true;
    let socketGeneration = 0;
    let dialGeneration = 0;
    let retry = 0;
    let userHungUp = false;
    let pendingDisconnects = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let layoutFrame = 0;
    let term: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let input: { dispose(): void } | undefined;
    let cursorWatch: { dispose(): void } | undefined;
    let screenObserver: ResizeObserver | undefined;
    let replySuppression: { dispose(): void } | undefined;
    let currentState: ConnectionState = { status: "connecting" };
    let inputEnabled = false;
    let outputReady = false;
    let endedReason: HangupReason | undefined;
    const skippedKeys = new Set<string>();
    let activeDial: {
      abort: AbortController;
      fastForward: AbortController;
      ready: () => void;
      fail: () => void;
      buffered: Uint8Array[];
      bytes: number;
      ended?: HangupReason;
      timeout: ReturnType<typeof setTimeout>;
    } | undefined;
    const updateState = (next: ConnectionState) => { currentState = next; setState(next); };
    const sendControl = (event: object) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(event));
    };
    // Space the glass can grow into: the frame's screen slot minus the
    // glass's own padding.
    const available = () => {
      const slot = slotRef.current;
      const glass = slot?.querySelector<HTMLElement>(".bbbbs-screen");
      if (!slot || !glass) return null;
      const style = getComputedStyle(glass);
      const px = (value: string) => Number.parseFloat(value) || 0;
      return {
        width: Math.max(0, slot.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
        height: Math.max(0, slot.clientHeight - px(style.paddingTop) - px(style.paddingBottom)),
      };
    };
    let revealFrame = 0;
    // When zoomed past the pane, keep the cursor (where the BBS is asking for
    // input) in view with a two-cell margin.
    const revealCursor = () => {
      cancelAnimationFrame(revealFrame);
      revealFrame = requestAnimationFrame(() => {
        const viewport = container.current; const box = stageBox.current;
        if (!alive || !term || !viewport || !box) return;
        if (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight) return;
        const cellW = box.offsetWidth / term.cols; const cellH = box.offsetHeight / term.rows;
        const { cursorX, cursorY } = term.buffer.active;
        const next = scrollToReveal(viewport, { x: cursorX * cellW, y: cursorY * cellH, width: cellW, height: cellH }, 2 * cellH);
        viewport.scrollTo({ left: next.left, top: next.top });
      });
    };
    let current: { space: { width: number; height: number }; layout: ReturnType<typeof fitLayout>; zoom: ZoomSetting } | undefined;
    // Scale the rendered grid: to fill the space exactly (smooth fit), or not
    // at all (crisp/fixed). Runs whenever xterm's screen element changes size,
    // because xterm re-measures its cells asynchronously after a font change.
    const applyScale = () => {
      const viewport = container.current; const box = stageBox.current; const host = stage.current;
      if (!alive || !current || !viewport || !box || !host) return;
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen?.offsetWidth || !screen.offsetHeight) return;
      const { space, layout, zoom } = current;
      const w = screen.offsetWidth; const h = screen.offsetHeight;
      const fill = Math.min(space.width / w, space.height / h);
      let scale = layout.scale ?? fill;
      if (zoom === "fit" && scale > fill) scale = fill; // never overflow in Fit
      host.style.width = `${w}px`; host.style.height = `${h}px`;
      host.style.transform = scale === 1 ? "" : `scale(${scale})`;
      box.style.width = `${w * scale}px`; box.style.height = `${h * scale}px`;
      // The glass hugs the grid; past the pane it scrolls instead of clipping.
      viewport.style.width = `${Math.min(w * scale, space.width)}px`;
      viewport.style.height = `${Math.min(h * scale, space.height)}px`;
      effectiveRef.current = layout.fontSize * scale;
      // BbsFrame's scanline spacing follows the displayed font size.
      setFontSize(layout.fontSize * scale);
      revealCursor();
    };
    const fit = () => {
      cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(() => {
        const space = available();
        if (!alive || !space || !stage.current || !term) return;
        const zoom = zoomRef.current;
        const layout = zoom === "fit" ? fitLayout(space.width, space.height) : fixedLayout(zoom);
        current = { space, layout, zoom };
        if (term.options.fontSize !== layout.fontSize) term.options.fontSize = layout.fontSize;
        applyScale(); // the screen observer re-applies once xterm has re-measured
        layoutFrame = requestAnimationFrame(applyScale);
        sendControl({ t: "resize", cols: 80, rows: 25 });
      });
    };
    fitRef.current = fit;
    const stopDial = () => {
      dialGeneration++;
      if (activeDial) {
        clearTimeout(activeDial.timeout);
        activeDial.abort.abort(); activeDial.fail(); activeDial = undefined;
      }
      inputEnabled = false;
      outputReady = false;
    };
    const showHangup = (next: ConnectionState) => {
      const reason = connectionHangupReason(next);
      inputEnabled = false;
      if (endedReason === reason) return;
      endedReason = reason;
      setHangup(reason);
      setDialing(false);
      if (activeDial) {
        activeDial.ended = reason;
        clearTimeout(activeDial.timeout);
        activeDial.fail(); activeDial.abort.abort();
      } else term?.write(noCarrierText(reason));
    };
    const enableInputAfterOutput = (generation: number) => {
      // Empty writes retain parser state and still run their queued callback.
      term?.write("", () => {
        if (!alive || generation !== dialGeneration) return;
        outputReady = true;
        inputEnabled = currentState.status === "registering" || currentState.status === "ready";
        setDialing(false); term?.focus();
      });
    };
    const streamWithoutDial = (tail?: Uint8Array) => {
      const buffered = activeDial?.buffered ?? [];
      stopDial();
      // Reset before server data, after any already-queued modem fragments.
      // A restored replay starts from the original blank terminal state.
      term?.write("\x1bc");
      for (const bytes of buffered) term?.write(bytes);
      if (tail) term?.write(tail);
      endedReason = undefined;
      setHangup(null); setDialing(false);
      enableInputAfterOutput(dialGeneration);
    };
    const beginDial = () => {
      stopDial();
      const generation = dialGeneration;
      endedReason = undefined;
      setHangup(null); setDialing(true);
      // Recovery remains pending until the backend dismisses it or the user
      // acknowledges it, including across upstream reconnects.
      setRecovering(false);
      let resolve!: () => void;
      let reject!: () => void;
      const connected = new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error("Connection ended")); });
      const dial: NonNullable<typeof activeDial> = {
        abort: new AbortController(), fastForward: new AbortController(),
        ready: () => { clearTimeout(dial.timeout); resolve(); }, fail: reject,
        buffered: [] as Uint8Array[], bytes: 0, ended: undefined as HangupReason | undefined,
        timeout: setTimeout(() => {
          if (!alive || generation !== dialGeneration) return;
          const next: ConnectionState = { status: "error", message: "The BBS did not answer. Redial to try again." };
          updateState(next); showHangup(next);
        }, 30000),
      };
      activeDial = dial;
      const finishDial = () => {
        if (!alive || generation !== dialGeneration || !term) return;
        clearTimeout(dial.timeout);
        for (const bytes of dial.buffered) term.write(bytes);
        activeDial = undefined;
        if (dial.ended) { term.write(noCarrierText(dial.ended)); return; }
        // Enable keys only after xterm has parsed all queued prompts.
        enableInputAfterOutput(generation);
      };
      // Guard every animation write: even its finally block may run after a redial or unmount.
      void playDialSequence({ write: (data) => {
        if (alive && generation === dialGeneration && !dial.abort.signal.aborted) term?.write(data);
      } }, { connected, signal: dial.abort.signal, fastForward: dial.fastForward.signal, sound: soundRef.current }).then(finishDial, () => {
        if (!alive || generation !== dialGeneration) return;
        const next: ConnectionState = { status: "error", message: "Could not finish dialing. Redial to try again." };
        updateState(next); showHangup(next); finishDial();
      });
    };
    const connect = () => {
      if (!alive || !term || userHungUp) return;
      pendingDisconnects = 0;
      const generation = ++socketGeneration;
      updateState({ status: retry ? "reconnecting" : "connecting" });
      beginDial();
      const url = new URL(`/api/v1/plugins/${encodeURIComponent(pluginId)}/http/terminal`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      let initialState = true;
      let initialReset = false;
      const current = () => alive && generation === socketGeneration && socketRef.current === socket;
      socket.onopen = () => { if (current()) { fit(); term?.focus(); } };
      socket.onmessage = (event) => {
        if (!current() || !term) return;
        if (event.data instanceof ArrayBuffer) {
          if (userHungUp || pendingDisconnects) return;
          retry = 0;
          const bytes = new Uint8Array(event.data);
          if (activeDial) {
            if (activeDial.ended) return;
            if (activeDial.bytes + bytes.byteLength > 1024 * 1024) {
              // Bound the extra animation queue without rejecting legitimate
              // long output. The rest streams straight to xterm in order.
              streamWithoutDial(bytes); return;
            }
            activeDial.ready(); activeDial.buffered.push(bytes); activeDial.bytes += bytes.byteLength;
          } else term.write(bytes);
          return;
        }
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as BrowserEvent;
          if (message.t === "confirm-token") confirmToken = message.token;
          if (message.t === "reset") {
            if (userHungUp || pendingDisconnects) return;
            if (initialState) initialReset = true;
            if (activeDial && !activeDial.ended && !activeDial.bytes) return;
            term.reset(); beginDial(); fit();
          }
          if (message.t === "state") {
            if (pendingDisconnects) {
              // Old output can already be in flight when Redial is clicked.
              // Ordered disconnect confirmations delimit that previous call.
              if (message.state.status === "disconnected") {
                pendingDisconnects--;
                if (userHungUp) updateState(message.state);
              }
              return;
            }
            if (userHungUp) {
              if (message.state.status === "disconnected") updateState(message.state);
              return;
            }
            const restored = initialState && initialReset && (message.state.status === "ready" || message.state.status === "registering");
            initialState = false;
            const previous = currentState;
            updateState(message.state);
            // attach sends an existing session's state before its replay.
            // New sessions send connecting first and keep the real dial-up.
            if (restored) streamWithoutDial();
            if (message.state.status === "registering" || message.state.status === "ready") {
              retry = 0;
              if (!activeDial) { endedReason = undefined; inputEnabled = outputReady; setHangup(null); }
              else if (!activeDial.ended) activeDial.ready();
            } else if (message.state.status === "connecting" || message.state.status === "reconnecting") {
              if (!activeDial || activeDial.ended || message.state.status === "reconnecting" && previous.status !== "reconnecting") beginDial();
            } else {
              if (previous.status !== message.state.status || !activeDial?.ended) showHangup(message.state);
            }
          }
          if (message.t === "recovery") { setRecovery({ handle: message.handle, password: message.password }); setSaved(false); }
          if (message.t === "recovery-dismissed") setRecovery(null);
        } catch {
          if (userHungUp || pendingDisconnects) return;
          const next: ConnectionState = { status: "error", code: "protocol", message: "Unexpected response. Redial to try again." };
          updateState(next); showHangup(next);
        }
      };
      socket.onclose = (event) => {
        if (!current()) return;
        socketRef.current = null;
        pendingDisconnects = 0;
        if (userHungUp) return;
        if (["error", "closed", "disconnected"].includes(currentState.status)) { activeDial?.fail(); return; }
        const next: ConnectionState = { status: "disconnected", message: "Disconnected. Redial to call again." };
        updateState(next); showHangup(next);
        if (event.code !== 1000 && retry < 5) {
          timer = setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
        }
      };
      socket.onerror = () => {}; // onclose handles transport failures without leaking browser error details.
    };
    reconnectRef.current = () => {
      userHungUp = false;
      clearTimeout(timer);
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        updateState({ status: "connecting" }); beginDial(); sendControl({ t: "reconnect" });
      } else {
        socketGeneration++;
        socketRef.current?.close(); socketRef.current = null;
        retry = 0; connect();
      }
      term?.focus();
    };
    disconnectRef.current = () => {
      userHungUp = true;
      clearTimeout(timer);
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        // Preserve this bridge: a rapid redial sends reconnect after disconnect
        // on the same ordered socket, rather than racing a new attachment.
        pendingDisconnects++;
        sendControl({ t: "disconnect" });
      } else {
        // A pending route cannot carry a session hangup; cancel it and backoff.
        socketGeneration++;
        pendingDisconnects = 0;
        socketRef.current?.close(1000, "User hung up"); socketRef.current = null;
      }
      stopDial();
      const next: ConnectionState = { status: "disconnected" };
      updateState(next); showHangup(next);
    };
    void loadBbsFont().then(() => {
      if (!alive || !container.current || !stage.current) return;
      const space = available();
      const zoom = zoomRef.current;
      const size = (zoom === "fit" ? fitLayout(space?.width ?? 640, space?.height ?? 400) : fixedLayout(zoom)).fontSize;
      term = new Terminal({ ...xtermOptions, fontSize: size, cursorBlink: !prefersReducedMotion(), scrollback: 0, allowProposedApi: false });
      replySuppression = suppressBrowserTerminalReplies(term);
      terminalRef.current = term;
      term.open(stage.current);
      // The first key skips the animation and is never sent to a registration prompt.
      term.attachCustomKeyEventHandler((event) => {
        // Zoom chords belong to the page (see the capture listener below).
        if (zoomCommandForKey(event)) return false;
        const key = event.code || event.key;
        if (skippedKeys.has(key)) {
          if (event.type === "keyup") skippedKeys.delete(key);
          event.preventDefault();
          return false;
        }
        if (activeDial) {
          if (event.type === "keydown") { skippedKeys.add(key); activeDial.fastForward.abort(); }
          event.preventDefault();
          return false;
        }
        if (!inputEnabled) event.preventDefault();
        return inputEnabled;
      });
      input = term.onData((text) => {
        if (activeDial) { activeDial.fastForward.abort(); return; }
        const socket = socketRef.current;
        if (!inputEnabled || socket?.readyState !== WebSocket.OPEN) return;
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += 4096) socket.send(bytes.slice(i, i + 4096));
      });
      cursorWatch = term.onCursorMove(revealCursor);
      observer = new ResizeObserver(fit); observer.observe(slotRef.current ?? container.current);
      const screenElement = stage.current.querySelector(".xterm-screen");
      if (screenElement) { screenObserver = new ResizeObserver(applyScale); screenObserver.observe(screenElement); }
      connect(); fit();
    });
    return () => {
      alive = false; socketGeneration++; stopDial();
      clearTimeout(timer); cancelAnimationFrame(layoutFrame); cancelAnimationFrame(revealFrame);
      fitRef.current = () => {}; cursorWatch?.dispose();
      reconnectRef.current = () => {};
      disconnectRef.current = () => {};
      observer?.disconnect(); screenObserver?.disconnect(); input?.dispose(); replySuppression?.dispose();
      socketRef.current?.close(1000, "Terminal hidden"); socketRef.current = null;
      term?.dispose(); terminalRef.current = null;
    };
  }, [pluginId]);

  // ---- terminal-only zoom, independent of bb's app zoom ----------------------
  const zoomTo = (next: ZoomSetting) => {
    zoomRef.current = next;
    fitRef.current();
    appearance.update({ zoom: zoomToStored(next) });
  };
  const zoomCommand = (command: ZoomCommand) =>
    zoomTo(command === "fit" ? "fit" : stepZoom(effectiveRef.current, command));
  const zoomCommandRef = useRef(zoomCommand);
  zoomCommandRef.current = zoomCommand;

  // Refit when the stored zoom changes (another view, settings, reload).
  useEffect(() => { fitRef.current(); }, [appearance.zoom]);

  useEffect(() => {
    // bb's desktop app binds Cmd/Ctrl +/−/0 to app zoom as menu accelerators,
    // which only fire for key events the page leaves unhandled. Claim them in
    // the capture phase while focus is inside the terminal frame.
    const onKey = (event: KeyboardEvent) => {
      const frame = frameRef.current;
      if (!frame) return;
      const inside = frame.contains(document.activeElement) || document.fullscreenElement === frame;
      if (!inside) return;
      if (event.key === "Escape" && document.fullscreenElement === frame) {
        event.preventDefault(); event.stopImmediatePropagation();
        void document.exitFullscreen().catch(() => {});
        return;
      }
      const command = zoomCommandForKey(event);
      if (!command) return;
      event.preventDefault(); event.stopImmediatePropagation();
      // Held A+/A− keys repeat; Fit doesn't.
      if (event.type === "keydown" && (!event.repeat || command !== "fit")) zoomCommandRef.current(command);
    };
    // Ctrl/Cmd + wheel (and trackpad pinch) over the terminal zooms the terminal.
    const wheelStep = createWheelZoom();
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const slot = slotRef.current;
      if (!slot || !(event.target instanceof Node) || !slot.contains(event.target)) return;
      event.preventDefault(); event.stopPropagation();
      const direction = wheelStep(event.deltaY, event.deltaMode);
      if (direction) zoomCommandRef.current(direction);
    };
    const onFullscreen = () => {
      setFullscreen(document.fullscreenElement === frameRef.current);
      fitRef.current(); terminalRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKey, { capture: true });
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keyup", onKey, { capture: true });
      window.removeEventListener("wheel", onWheel, { capture: true });
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, []);

  // Account dialogs live outside the frame: leave BBS mode so they're visible.
  useEffect(() => {
    if ((recovery || recovering) && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, [recovery, recovering]);

  const toggleFullscreen = () => {
    const frame = frameRef.current;
    if (!frame) return;
    if (document.fullscreenElement === frame) void document.exitFullscreen().catch(() => {});
    else void frame.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
    terminalRef.current?.focus();
  };
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const shortcuts = zoomShortcutLabels(isMac);
  const zoomSetting = zoomFromStored(appearance.zoom);
  // What's on screen, relative to the native 8×16 VGA cell.
  const zoomLabel = `${Math.round((fontSize / 16) * 100)}%`;
  const zoomControls = <>
    <button type="button" className="bbbbs-switch" onClick={() => zoomCommand("out")} title={`Smaller text (${shortcuts.out}, or ${shortcuts.wheel})`} aria-label="Smaller terminal text">A−</button>
    <span className="bbbbs-zoom-readout" aria-live="polite" title={zoomSetting === "fit" ? "Terminal zoom: fitted to the pane (only the terminal, not bb)" : "Terminal zoom (only the terminal, not bb)"}>{zoomLabel}</span>
    <button type="button" className="bbbbs-switch" onClick={() => zoomCommand("in")} title={`Bigger text (${shortcuts.in}, or ${shortcuts.wheel})`} aria-label="Bigger terminal text">A+</button>
    <button type="button" className="bbbbs-switch" aria-pressed={zoomSetting === "fit"} onClick={() => zoomCommand("fit")} title={`Fit the pane (${shortcuts.fit})`}>Fit</button>
    <button type="button" className="bbbbs-switch" aria-pressed={fullscreen} onClick={toggleFullscreen} title={fullscreen ? "Leave BBS mode (Esc)" : "BBS mode: fullscreen terminal (Esc to leave)"}>BBS mode</button>
  </>;

  const control = (t: "disconnect" | "recovery-saved") => {
    if (t === "disconnect") disconnectRef.current();
    else if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ t }));
    terminalRef.current?.focus();
  };
  const frameState = hangup ? "no-carrier" : dialing ? "dialing" : state.status === "ready" || state.status === "registering" ? "online" : "idle";
  const statusText = dialing ? "Dialing… · press any key to skip" : state.status === "registering" ? "New caller · 2400 baud" : state.status === "ready" ? `Online · 2400 baud${state.node ? ` · node ${state.node}` : ""}${state.handle ? ` · ${state.handle}` : ""}` : state.message ?? state.status;
  return <div className="bbs-terminal-page">
    <div className="bbs-terminal-toolbar">
      <span>bbBBS · 80 × 25</span>
      <div>
        <button onClick={() => setRecovering(true)} title="See your recovery password, or log in with an account from another installation">Account</button>
        <button onClick={() => reconnectRef.current()}>Redial</button>
        <button onClick={() => control("disconnect")}>Hang up</button>
      </div>
    </div>
    {appearance.error && <p className="bbs-terminal-message" role="alert">{appearance.error}</p>}
    {!recovery && state.code === REGISTRATION_INTERRUPTED && <div className="bbs-terminal-message" role="alert">
      <p>{state.message}</p>
      <StartNewAccount onStarted={() => reconnectRef.current()} />
    </div>}
    <BbsFrame className="bbs-terminal-frame" layout="fill" frameRef={frameRef} slotRef={slotRef} controls={zoomControls} state={frameState} crt={appearance.crt} onCrtChange={(crt) => appearance.update({ crt })}
      sound={appearance.sound} onSoundChange={(sound) => appearance.update({ sound })} fontSize={fontSize} statusText={statusText}
      hangup={hangup ? { reason: hangup, onAction: () => {
        if (hangup === "bad_auth") { setRecovering(true); setHangup(null); }
        else if (hangup === "banned" || hangup === "agents_disabled") setHangup(null);
        else reconnectRef.current();
      }, onDismiss: () => setHangup(null) } : null}>
      <div className="bbs-terminal-viewport bbbbs-scroll" ref={container} aria-label="BBS terminal, 80 columns and 25 rows" onClick={() => terminalRef.current?.focus()}>
        <div className="bbs-terminal-stagebox" ref={stageBox}>
          <div className="bbs-terminal-stage" ref={stage} />
        </div>
      </div>
    </BbsFrame>
    {recovering && <div className="bbs-recovery-overlay" role="dialog" aria-modal="true" aria-labelledby="bbs-account-recovery-title">
      <div className="bbs-recovery-card">
        <h2 id="bbs-account-recovery-title">Account</h2>
        <AccountRecovery expanded />
        <button onClick={() => { setRecovering(false); reconnectRef.current(); }}>Redial</button>
        {" "}<button onClick={() => setRecovering(false)}>Close</button>
      </div>
    </div>}
    {recovery && <div className="bbs-recovery-overlay" role="dialog" aria-modal="true" aria-labelledby="bbs-recovery-title">
      <div className="bbs-recovery-card">
        <h2 id="bbs-recovery-title">Save your recovery password</h2>
        <p>{recovery.handle
          ? <>Keep this password for <strong>{recovery.handle}</strong>. It lets you return from another bb installation.</>
          : REGISTRATION_INTERRUPTED_MESSAGE}</p>
        <input aria-label="Your recovery password" readOnly value={recovery.password} onFocus={(event) => event.target.select()} autoComplete="off" spellCheck={false} />
        <label><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /> I saved it somewhere safe.</label>
        <button disabled={!saved} onClick={() => { control("recovery-saved"); setRecovery(null); }}>Continue to the BBS</button>
        {!recovery.handle && <StartNewAccount onStarted={() => { setRecovery(null); reconnectRef.current(); }} />}
      </div>
    </div>}
  </div>;
}

export default definePluginApp((app) => {
  // The terminal is the page: it opens straight into the main area, where it
  // has the most room. Account recovery lives in its toolbar and settings.
  app.slots.navPanel({ id: "bbs", title: "bbBBS", icon: "Terminal", path: "bbbbs", component: BbsTerminal });
  app.slots.settingsSection({ id: "recovery", title: "Account recovery", component: AccountRecovery });
  app.slots.settingsSection({ id: "about", title: "About bbBBS", component: BbsAbout });
});

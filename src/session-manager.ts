import { randomBytes } from "node:crypto";
import { GatewayClient } from "./gateway-client";
import type { ConnectionState, ServerControl } from "./protocol";
import { Screen, type ScreenSnapshot } from "./screen";
import { encodeKeys } from "./keys";
import { browserControlSchema, type BrowserEvent, type BrowserPeer } from "./bridge";
import type { SettingsStore } from "./settings";
import { ReplayBoundary } from "./replay-boundary";
import { MAX_KEY_INPUT_BYTES } from "./limits";
import { SecretRedactor } from "./secret-redactor";
import { REGISTRATION_INTERRUPTED, REGISTRATION_INTERRUPTED_MESSAGE } from "./messages";

interface Session {
  client: GatewayClient;
  screen: Screen;
  replay: { id: number; bytes: Uint8Array }[];
  replayBytes: number;
  replaySequence: number;
  output: Promise<void>;
  boundary: ReplayBoundary;
  lastUsed: number;
  operations: Promise<unknown>;
  /** Human input waits on this while the gateway's recovery screen is being recorded as at-risk. */
  inputGate?: Promise<void>;
  /** The gateway printed this registration's recovery screen. */
  recoveryOnScreen?: boolean;
}

const REPLAY_LIMIT = 1024 * 1024;
/** Refusal to send a second register hello for a secret the gateway may already own. */
class RegistrationInterruptedError extends Error {
  readonly code = REGISTRATION_INTERRUPTED;
  constructor() { super(REGISTRATION_INTERRUPTED_MESSAGE); }
}
const humanState = (state: ConnectionState): ConnectionState => state.code === REGISTRATION_INTERRUPTED ? { ...state, message: REGISTRATION_INTERRUPTED_MESSAGE } : state;
const failure = (error: unknown, message: string): ConnectionState => error instanceof RegistrationInterruptedError
  ? { status: "error", code: error.code, message: error.message } : { status: "error", message };
// Local resource bound, independent of the gateway's configurable owner limit.
// Gateway `full` errors report capacity without agent startup retries.
const MAX_AGENTS = 8;

/** One human connection mirrored to visible panes; one isolated agent connection per bb thread. */
export class SessionManager {
  private human?: Session;
  private humanStarting?: Promise<Session>;
  private humanClosing: Promise<void> = Promise.resolve();
  private agents = new Map<string, Session>();
  private agentStarting = new Map<string, Promise<Session>>();
  private peers = new Set<BrowserPeer>();
  private detachedTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private epoch = 0;
  private humanGeneration = 0;
  private nextAgentGeneration = 0;
  private agentGenerations = new Map<string, number>();
  private recoveryPeer?: BrowserPeer;
  private sweep = setInterval(() => {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, session] of this.agents) if (session.lastUsed < cutoff) this.closeAgent(id);
  }, 60_000);

  /** `confirmToken` is sent to attached views so RPC callers can prove they are the human UI. */
  constructor(private store: SettingsStore, private confirmToken?: string) { this.sweep.unref(); }

  private send(peer: BrowserPeer, event: BrowserEvent | Uint8Array) {
    if (peer.readyState === 1) peer.send(event instanceof Uint8Array ? event : JSON.stringify(event));
  }

  private broadcast(event: BrowserEvent | Uint8Array) {
    for (const peer of this.peers) this.send(peer, event);
  }

  private async offerRecovery() {
    const epoch = this.epoch;
    if (this.disposed || this.recoveryPeer || !await this.store.recoveryPending()) return;
    // The gateway's own recovery screen is showing; a second display would add nothing.
    if (this.human?.recoveryOnScreen && this.human.client.state.status === "registering") return;
    const account = await this.store.get();
    const interrupted = !account.handle && await this.store.registrationInterrupted();
    if (this.disposed || epoch !== this.epoch || this.recoveryPeer) return;
    const peer = [...this.peers].find((view) => view.readyState === 1);
    // An interrupted registration has no confirmed handle; the user supplies the one they chose.
    if (peer && account.secret && (account.handle || interrupted)) {
      this.recoveryPeer = peer;
      // The single intentional credential display required by protocol v1.
      // Never part of settings RPC, logs, replay, realtime broadcasts, or agent screens.
      this.send(peer, { t: "recovery", handle: account.handle, password: account.secret });
    }
  }

  private async newSession(kind: "human" | "agent", current: () => boolean): Promise<Session> {
    const epoch = this.epoch;
    const active = () => !this.disposed && epoch === this.epoch && current();
    let account = await this.store.get();
    if (!active()) throw new Error("BBS session was reset.");
    if (kind === "agent" && (!account.allowAgents || !account.handle || !account.secret)) {
      throw new Error(account.allowAgents ? "Open the BBS and finish registration first." : "Agent access is off. Enable ‘Allow my agents into the BBS’ in BBS settings.");
    }
    if (account.handle && !account.secret) throw new Error("Enter the saved recovery password in BBS settings.");
    // Never send a second register hello for a secret the gateway may already own.
    if (kind === "human" && !account.handle && account.secret && await this.store.registrationInterrupted()) throw new RegistrationInterruptedError();
    if (!account.secret) {
      // Re-read just before writing: a concurrent recover may have saved credentials, which must win.
      account = await this.store.get();
      if (!active()) throw new Error("BBS session was reset.");
      if (!account.secret) await this.store.save({ secret: randomBytes(32).toString("base64url") });
      account = await this.store.get();
    }
    if (!active()) throw new Error("BBS session was reset.");
    const screen = new Screen(80, 25, (bytes) => {
      // The backend parser owns ANSI query replies. Browser views also parse
      // historical replay, so their parser replies must never reach the BBS.
      if (active() && ["registering", "ready"].includes(session.client.state.status)) {
        // Parsing can finish after the socket closes or reaches its input
        // buffer limit. Never let a late report escape xterm's parser callback.
        this.sendInput(session, bytes, () => {});
      }
    });
    let gatewayRecoveryShown = false;
    let startupTail = "";
    // Live views may show the gateway's recovery screen once. Replay, and the
    // parser that compaction serializes, only ever see the masked stream.
    const redactor = kind === "human" && !account.handle ? new SecretRedactor(account.secret!, () => {
      if (gatewayRecoveryShown) return;
      gatewayRecoveryShown = session.recoveryOnScreen = true;
      this.recoveryPeer = undefined;
      this.broadcast({ t: "recovery-dismissed" });
      // The gateway creates the account once this screen is acknowledged. Record that before any
      // input can acknowledge it, so a drop, reload or hang-up never leads to a second register hello.
      const recorded = this.store.setRegistrationInterrupted(true).then(() => this.store.setRecoveryPending(true)).catch(() => {});
      session.inputGate = Promise.all([session.inputGate, recorded]).then(() => {});
    }) : undefined;
    const session: Session = { client: undefined as unknown as GatewayClient, screen, replay: [], replayBytes: 0, replaySequence: 0, output: Promise.resolve(), boundary: new ReplayBoundary(), lastUsed: Date.now(), operations: Promise.resolve() };
    const registered = async (control: ServerControl) => {
      if (control.t === "registered" && redactor) record(redactor.end());
      if (control.t === "registered" && kind === "human" && active()) {
        await session.inputGate;
        await this.store.save({ handle: control.handle });
        if (!active()) return;
        await this.store.setRegistrationInterrupted(false);
        await this.store.setRecoveryPending(!gatewayRecoveryShown);
        if (!active()) return;
        if (!gatewayRecoveryShown) await this.offerRecovery();
      }
    };
    // Feed replay and the parser; live views already received the raw bytes.
    const record = (stored: Uint8Array) => {
      if (!active() || !stored.byteLength) return;
      const id = ++session.replaySequence;
      const safeBoundary = session.boundary.feed(stored);
      if (kind === "human") { session.replay.push({ id, bytes: stored }); session.replayBytes += stored.byteLength; }
      // Queue parser work in frame order. Bytes still bridge immediately for low latency.
      session.output = session.output.then(async () => {
        if (!active()) return;
        await screen.write(stored);
        if (kind === "human" && safeBoundary && session.replayBytes > REPLAY_LIMIT) {
          const view = await screen.serialize();
          if (!active()) return;
          const suffix = session.replay.filter((frame) => frame.id > id);
          session.replay = [{ id, bytes: view }, ...suffix];
          session.replayBytes = session.replay.reduce((total, frame) => total + frame.bytes.byteLength, 0);
        }
      }).catch(() => { /* reset/disposal may race an in-flight parser callback */ });
    };
    session.client = new GatewayClient({
      url: account.serverUrl, kind,
      accountMayExist: () => gatewayRecoveryShown,
      startupCloseRetries: kind === "human" && !!account.handle ? 3 : 0,
      auth: account.handle ? { mode: "login", handle: account.handle, secret: account.secret! } : { mode: "register", secret: account.secret! },
      onData: (bytes) => {
        if (!active()) return;
        const copy = bytes.slice();
        if (kind === "human") {
          // Reaching the menu confirms startup. A later logoff is intentional
          // and must never be converted into another login.
          startupTail = (startupTail + Buffer.from(copy).toString("utf8")).slice(-4096);
          if (startupTail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("MAIN MENU")) {
            session.client.confirmStartup(); startupTail = "";
          }
        }
        record(redactor?.feed(copy) ?? copy);
        if (kind === "human") this.broadcast(copy);
      },
      onControl: registered,
      onState: (state) => {
        if (state.status === "connecting" || state.status === "reconnecting") startupTail = "";
        if (kind !== "human" || !active()) return;
        this.broadcast({ t: "state", state: humanState(state) });
        // The flags were recorded when the recovery screen appeared.
        if (state.code === REGISTRATION_INTERRUPTED) void Promise.resolve(session.inputGate).then(() => this.offerRecovery()).catch(() => {});
      },
    });
    return session;
  }

  private ensureHuman(): Promise<Session> {
    if (this.human) return Promise.resolve(this.human);
    if (this.humanStarting) return this.humanStarting;
    const generation = this.humanGeneration;
    const current = () => generation === this.humanGeneration;
    const start = this.humanClosing.then(() => this.newSession("human", current)).then(async (session) => {
      if (!current() || this.disposed) { session.client.close(); session.screen.dispose(); throw new Error("BBS session was reset."); }
      this.human = session;
      await session.client.connect();
      return session;
    });
    this.humanStarting = start;
    void start.finally(() => { if (this.humanStarting === start) this.humanStarting = undefined; }).catch(() => {});
    return start;
  }

  async attach(peer: BrowserPeer) {
    const generation = this.humanGeneration;
    if (this.disposed) { peer.close(1012, "Plugin reloaded"); return; }
    clearTimeout(this.detachedTimer);
    this.peers.add(peer);
    this.send(peer, { t: "reset" });
    if (this.confirmToken) this.send(peer, { t: "confirm-token", token: this.confirmToken });
    try {
      const existing = this.human;
      if (existing) {
        this.send(peer, { t: "state", state: humanState(existing.client.state) });
        for (const frame of existing.replay) this.send(peer, frame.bytes);
      }
      await this.ensureHuman();
      await this.offerRecovery();
    } catch (error) {
      if (generation === this.humanGeneration && !this.disposed) {
        this.send(peer, { t: "state", state: failure(error, "Could not connect. Check BBS settings and your recovery password, then reconnect.") });
        await this.offerRecovery().catch(() => {});
      }
    }
  }

  detach(peer: BrowserPeer) {
    if (!this.peers.delete(peer)) return;
    if (this.recoveryPeer === peer) { this.recoveryPeer = undefined; void this.offerRecovery(); }
    if (!this.peers.size && !this.disposed) {
      this.detachedTimer = setTimeout(() => this.closeHuman(), 60_000);
      this.detachedTimer.unref();
    }
  }

  async receive(peer: BrowserPeer, data: string | Uint8Array) {
    if (!this.peers.has(peer) || this.disposed) return;
    let generation = this.humanGeneration;
    try {
      if (typeof data !== "string") {
        if (data.byteLength > MAX_KEY_INPUT_BYTES) throw new Error("Too much terminal input.");
        // A rules-pause acknowledgement alone does not confirm startup.
        // Other user commands/abort keys end automatic startup retries.
        if (this.human?.client.state.status === "ready" && data.some((byte) => ![9, 10, 13, 32].includes(byte))) {
          this.human.client.confirmStartup();
        }
        if (this.human) this.sendInput(this.human, data, (error) => this.reportInputError(peer, generation, error));
        return;
      }
      if (data.length > 1024) throw new Error("Control message is too large.");
      const control = browserControlSchema.parse(JSON.parse(data));
      if (control.t === "resize" && this.human) {
        this.human.client.resize(control.cols, control.rows);
        this.human.screen.resize(control.cols, control.rows);
        this.human.boundary.resize(control.rows);
      }
      if (control.t === "reconnect") {
        this.closeHuman(); generation = this.humanGeneration;
        this.broadcast({ t: "reset" }); await this.ensureHuman();
      }
      if (control.t === "disconnect") {
        this.closeHuman(); this.broadcast({ t: "state", state: { status: "disconnected" } });
      }
      if (control.t === "recovery-saved" && this.recoveryPeer === peer) {
        await this.store.setRecoveryPending(false); this.recoveryPeer = undefined;
        this.broadcast({ t: "recovery-dismissed" });
      }
    } catch (error) {
      this.reportInputError(peer, generation, error);
    }
  }

  /** Send now, or after the recovery screen is recorded, keeping input in order either way. */
  private sendInput(session: Session, bytes: Uint8Array, onError: (error: unknown) => void) {
    const send = () => { try { session.client.send(bytes); } catch (error) { onError(error); } };
    if (!session.inputGate) { send(); return; }
    const gate = session.inputGate = session.inputGate.then(send);
    void gate.then(() => { if (session.inputGate === gate) session.inputGate = undefined; });
  }

  private reportInputError(peer: BrowserPeer, generation: number, error: unknown) {
    if (generation === this.humanGeneration && this.peers.has(peer) && !this.disposed) {
      this.send(peer, { t: "state", state: failure(error, "Input could not be sent. Reconnect or check BBS settings.") });
    }
  }

  private closeHuman() {
    this.humanGeneration++; this.humanStarting = undefined;
    const previous = this.human;
    this.human = undefined;
    if (previous) {
      const closed = previous.client.closeAndWait();
      previous.screen.dispose();
      // The gateway waits for native node cleanup. The client only needs to
      // serialize old transport closure before starting the next login.
      this.humanClosing = Promise.all([this.humanClosing, closed]).then(() => {});
    }
  }

  closeAgent(threadId: string) {
    this.agentGenerations.delete(threadId); this.agentStarting.delete(threadId);
    const session = this.agents.get(threadId);
    session?.client.close(); session?.screen.dispose(); this.agents.delete(threadId);
  }

  resetAgents() {
    this.agentGenerations.clear(); this.agentStarting.clear();
    for (const id of this.agents.keys()) this.closeAgent(id);
  }

  resetAll() {
    this.epoch++; this.closeHuman(); this.resetAgents();
    this.recoveryPeer = undefined;
    this.broadcast({ t: "recovery-dismissed" });
    this.broadcast({ t: "reset" });
    this.broadcast({ t: "state", state: { status: "disconnected", message: "Settings changed. Reconnect to use them." } });
  }

  private async ensureAgent(threadId: string, signal: AbortSignal): Promise<Session> {
    if (signal.aborted) throw new Error("BBS call cancelled.");
    const account = await this.store.get();
    if (!account.allowAgents) { this.resetAgents(); throw new Error("Agent access is off. Enable ‘Allow my agents into the BBS’ in BBS settings."); }
    let session = this.agents.get(threadId);
    if (session && ["error", "closed"].includes(session.client.state.status)) {
      this.closeAgent(threadId); session = undefined;
    }
    if (!session) {
      let start = this.agentStarting.get(threadId);
      if (!start) {
        if (new Set([...this.agents.keys(), ...this.agentStarting.keys()]).size >= MAX_AGENTS) throw new Error("Eight agent sessions are already open. Try again after another session ends.");
        const generation = ++this.nextAgentGeneration;
        this.agentGenerations.set(threadId, generation);
        const current = () => this.agentGenerations.get(threadId) === generation;
        start = this.newSession("agent", current).then(async (created) => {
          if (!current() || this.disposed) { created.client.close(); created.screen.dispose(); throw new Error("BBS session was reset."); }
          this.agents.set(threadId, created);
          await created.client.connect();
          return created;
        });
        this.agentStarting.set(threadId, start);
        const pending = start;
        void start.finally(() => { if (this.agentStarting.get(threadId) === pending) this.agentStarting.delete(threadId); }).catch(() => {});
      }
      session = await start;
    }
    session.lastUsed = Date.now();
    try {
      await session.client.waitUntilReady(signal);
    } catch (error) {
      // Capacity/auth failures must not occupy local slots until the idle sweep.
      if (this.agents.get(threadId) === session && ["error", "closed"].includes(session.client.state.status)) this.closeAgent(threadId);
      throw error;
    }
    return session;
  }

  async agentScreen(threadId: string, signal: AbortSignal): Promise<ScreenSnapshot & { connection: ConnectionState }> {
    const session = await this.ensureAgent(threadId, signal);
    await session.output;
    await session.screen.flush();
    return { ...session.screen.read(threadId), connection: session.client.state };
  }

  async agentKeys(threadId: string, input: { text?: string; keys?: string[]; waitMs?: number }, signal: AbortSignal): Promise<ScreenSnapshot & { connection: ConnectionState }> {
    const bytes = encodeKeys(input);
    const session = await this.ensureAgent(threadId, signal);
    const operation = session.operations.catch(() => {}).then(async () => {
      if (!(await this.store.get()).allowAgents || signal.aborted) throw new Error("Agent access is off or this call was cancelled.");
      session.client.send(bytes);
      await session.screen.settle(input.waitMs ?? 250, signal);
      await session.output;
      return { ...session.screen.read(threadId), connection: session.client.state };
    });
    session.operations = operation;
    return operation;
  }

  dispose() {
    this.disposed = true; clearInterval(this.sweep); clearTimeout(this.detachedTimer);
    this.resetAll();
    for (const peer of this.peers) peer.close(1012, "Plugin reloaded");
    this.peers.clear();
  }
}

import WebSocket, { type RawData } from 'ws';
import {
  type Auth, type ClientControl, type ConnectionState, type ServerControl,
  MAX_OUTPUT_BYTES, parseServerControl, validateAuth, validateDimensions,
} from './protocol.js';
import { MAX_GATEWAY_INPUT_BYTES } from './limits.js';
import { REGISTRATION_INTERRUPTED } from './messages.js';

export type { Auth, ConnectionState, ServerControl } from './protocol.js';

export interface GatewayClientOptions {
  url: string;
  kind: 'human' | 'agent';
  auth: Auth;
  cols?: number;
  rows?: number;
  reconnect?: boolean;
  /** Registration: whether a drop now could leave an account behind (the recovery screen was shown). */
  accountMayExist?: () => boolean;
  /** Human login sessions: tolerate busy startup or native logoff before the menu. */
  startupCloseRetries?: number;
  onData?: (bytes: Uint8Array) => void;
  onControl?: (message: ServerControl) => void | Promise<void>;
  onState?: (state: ConnectionState) => void;
}

const MAX_RECONNECTS = 5;
const HEARTBEAT_MS = 30000;
const PONG_TIMEOUT_MS = 10000;
const STARTUP_WINDOW_MS = 3000;
const CLOSE_TIMEOUT_MS = 1000;

/** Backend-only transport. Credentials are never part of state or callback data. */
export class GatewayClient {
  private readonly options: GatewayClientOptions;
  private auth: Auth;
  private cols: number;
  private rows: number;
  private socket?: WebSocket;
  private current: ConnectionState = { status: 'disconnected' };
  private stopped = false;
  private retries = 0;
  private startupRetries = 0;
  private readyAt?: number;
  private startupConfirmed = false;
  private startupEnd?: Extract<ServerControl, { t: 'bye' | 'error' }>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private connecting?: Promise<void>;
  private rejectConnect?: (error: Error) => void;
  private controls: Promise<void> = Promise.resolve();
  private readonly waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

  constructor(options: GatewayClientOptions) {
    const url = new URL(options.url);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
      throw new Error('Gateway URL must be a WebSocket URL without credentials, query, or fragment.');
    }
    if (options.kind !== 'human' && options.kind !== 'agent') throw new Error('Invalid gateway client kind.');
    if (!Number.isInteger(options.startupCloseRetries ?? 0) || (options.startupCloseRetries ?? 0) < 0 || (options.startupCloseRetries ?? 0) > 3) {
      throw new Error('Startup close retries must be an integer between 0 and 3.');
    }
    validateAuth(options.auth, options.kind);
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 25;
    validateDimensions(this.cols, this.rows);
    this.auth = { ...options.auth };
    // Keep a copy: caller mutation must never change the handshake or callbacks.
    this.options = { ...options, auth: this.auth };
  }

  get state(): ConnectionState { return { ...this.current }; }

  /** Resolves when the socket opens and hello is sent, including registration. */
  connect(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Gateway client is closed.'));
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.setState({ status: this.retries || this.startupRetries ? 'reconnecting' : 'connecting' });
    if (this.stopped) return Promise.reject(new Error('Gateway client is closed.'));
    this.readyAt = undefined;
    this.startupConfirmed = false;
    this.startupEnd = undefined;
    const socket = new WebSocket(this.options.url, { maxPayload: MAX_OUTPUT_BYTES, handshakeTimeout: 10000, perMessageDeflate: false });
    this.socket = socket;
    this.controls = Promise.resolve();
    let registerSent = false;
    const opened = new Promise<void>((resolve, reject) => {
      this.rejectConnect = reject;
      socket.once('open', () => {
        if (this.socket !== socket || this.stopped) return;
        this.sendControl({ t: 'hello', v: 1, client: 'bbbbs/0.1.0', cols: this.cols, rows: this.rows, kind: this.options.kind, auth: this.auth });
        if (this.auth.mode === 'register') { registerSent = true; this.setState({ status: 'registering' }); }
        if (this.stopped) return;
        this.startHeartbeat(socket);
        resolve();
      });
    });
    const pending = opened.finally(() => {
      if (this.connecting === pending) {
        this.connecting = undefined;
        this.rejectConnect = undefined;
      }
    });
    this.connecting = pending;
    socket.on('message', (data: RawData, binary: boolean) => {
      if (this.socket !== socket || this.stopped) return;
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      if (binary) {
        try { this.options.onData?.(new Uint8Array(bytes)); }
        catch { this.fail('callback', 'Terminal data could not be processed.'); }
        return;
      }
      this.controls = this.controls.then(async () => {
        if (this.socket !== socket || this.stopped) return;
        let message: ServerControl;
        try { message = parseServerControl(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { this.fail('protocol', 'Invalid gateway control frame.'); return; }
        await this.handleControl(message);
      }).catch(() => this.fail('callback', 'Gateway control could not be processed.'));
    });
    socket.on('error', (error: Error & { code?: string }) => {
      // Do not forward ws errors, which can contain URLs or server response text.
      if (this.socket !== socket) return;
      if (error.code?.startsWith('WS_ERR_')) this.fail('protocol', 'Invalid gateway WebSocket frame.');
      else this.rejectConnect?.(new Error('Gateway connection failed.'));
    });
    socket.on('close', (code: number) => {
      // Drain preceding control frames before deciding whether to reconnect.
      void this.controls.then(async () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.clearHeartbeat();
        this.rejectConnect?.(new Error('Gateway connection closed before opening.'));
        if (this.stopped) return;
        if (registerSent && this.auth.mode === 'register') {
          // Never resend a register hello on this client. Once the account may exist, another one could duplicate or orphan it.
          if (this.options.accountMayExist?.() ?? true) this.finish({ status: 'error', code: REGISTRATION_INTERRUPTED, message: 'Connection dropped before registration was confirmed.' });
          else this.finish({ status: 'error', message: 'Registration did not finish. Reconnect to start again.' });
          return;
        }
        const startupEnd = this.startupEnd;
        this.startupEnd = undefined;
        const normalClose = code === 1000 || code === 1005;
        if ((startupEnd && !this.startupConfirmed) || (normalClose && this.canRetryStartup())) {
          const delay = 1500 * 2 ** this.startupRetries++;
          this.scheduleReconnect(delay, startupEnd?.t === 'error' ? 'BBS is busy. Reconnecting…' : 'BBS ended during startup. Reconnecting…');
        } else if (startupEnd) {
          this.finish(startupEnd.t === 'error'
            ? { status: 'error', code: startupEnd.code, message: startupEnd.message }
            : { status: 'closed', message: startupEnd.reason });
          await this.options.onControl?.(startupEnd);
        } else if (code === 1006 && this.options.reconnect !== false && this.retries < MAX_RECONNECTS) {
          const delay = Math.min(500 * 2 ** this.retries++, 8000);
          this.scheduleReconnect(delay, 'Connection lost. Reconnecting…');
        } else if (normalClose) {
          this.finish({ status: 'closed', message: 'Connection closed.' });
        } else {
          this.finish({ status: 'error', code: 'connection', message: 'Gateway connection lost.' });
        }
      }).catch(() => this.fail('callback', 'Gateway control could not be processed.'));
    });
    return pending;
  }

  waitUntilReady(signal?: AbortSignal, timeoutMs = 15000): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('Waiting for the gateway was cancelled.'));
    if (this.current.status === 'ready') return Promise.resolve();
    if (this.stopped) return Promise.reject(new Error(this.current.message ?? 'Gateway session is closed.'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Invalid gateway wait timeout.'));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.waiters.delete(waiter); };
      const waiter = {
        resolve: () => { cleanup(); resolve(); },
        reject: (error: Error) => { cleanup(); reject(error); },
      };
      const abort = () => waiter.reject(new Error('Waiting for the gateway was cancelled.'));
      const timer = setTimeout(() => waiter.reject(new Error('Gateway did not become ready in time.')), timeoutMs);
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  send(bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_GATEWAY_INPUT_BYTES) throw new Error('Invalid terminal input size.');
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Gateway is disconnected.');
    if (this.socket.bufferedAmount + bytes.byteLength > MAX_OUTPUT_BYTES) throw new Error('Gateway input buffer is full.');
    this.socket.send(bytes, { binary: true });
  }

  resize(cols: number, rows: number): void {
    validateDimensions(cols, rows);
    this.cols = cols;
    this.rows = rows;
    if (!this.stopped && this.socket?.readyState === WebSocket.OPEN) this.sendControl({ t: 'resize', cols, rows });
  }

  close(): void { this.finish({ status: 'closed' }); }

  /** Await the captured transport's close event before starting another session. */
  closeAndWait(): Promise<void> {
    const socket = this.socket;
    const closed = socket ? this.waitForSocketClose(socket) : Promise.resolve();
    this.close();
    return closed;
  }

  /** The human main menu has arrived; a subsequent logoff is intentional. */
  confirmStartup(): void { this.startupConfirmed = true; }

  private async handleControl(message: ServerControl): Promise<void> {
    switch (message.t) {
      case 'registered':
        if (this.auth.mode !== 'register') { this.fail('protocol', 'Unexpected registration response.'); return; }
        this.auth = { mode: 'login', handle: message.handle, secret: this.auth.secret };
        await this.options.onControl?.(message);
        return;
      case 'ready':
        if (this.auth.mode !== 'login') { this.fail('protocol', 'Gateway skipped registration.'); return; }
        this.readyAt = Date.now();
        await this.options.onControl?.(message);
        if (this.stopped) return;
        this.retries = 0;
        this.setState({ status: 'ready', handle: message.handle, node: message.node });
        for (const waiter of this.waiters) waiter.resolve();
        return;
      case 'error':
        if (message.code === 'full' && this.readyAt === undefined && this.hasStartupRetryBudget()) {
          this.deferStartupEnd({ ...message, message: this.redact(message.message) });
          return;
        }
        this.finish({ status: 'error', code: message.code, message: this.redact(message.message) });
        await this.options.onControl?.({ ...message, message: this.redact(message.message) });
        return;
      case 'bye':
        if (message.reason === 'logoff' && this.canRetryStartup()) {
          this.deferStartupEnd(message);
          return;
        }
        this.finish({ status: 'closed', message: message.reason });
        await this.options.onControl?.(message);
        return;
      case 'pong':
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        await this.options.onControl?.(message);
    }
  }

  private redact(message: string): string { return message.split(this.auth.secret).join('[redacted]'); }

  private hasStartupRetryBudget(): boolean {
    return this.options.kind === 'human' && this.auth.mode === 'login' &&
      this.startupRetries < (this.options.startupCloseRetries ?? 0) && !this.startupConfirmed;
  }

  private canRetryStartup(): boolean {
    return this.hasStartupRetryBudget() && this.readyAt !== undefined && Date.now() - this.readyAt < STARTUP_WINDOW_MS;
  }

  private deferStartupEnd(message: Extract<ServerControl, { t: 'bye' | 'error' }>): void {
    this.startupEnd = message;
    this.clearHeartbeat();
    this.setState({ status: 'reconnecting', message: message.t === 'error' ? 'BBS is busy. Reconnecting…' : 'BBS ended during startup. Reconnecting…' });
    if (this.stopped) return;
    const socket = this.socket;
    if (socket) {
      void this.waitForSocketClose(socket);
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  }

  private scheduleReconnect(delay: number, message: string): void {
    this.setState({ status: 'reconnecting', message });
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => { void this.connect().catch(() => {}); }, delay);
    this.reconnectTimer.unref();
  }

  private waitForSocketClose(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolve => {
      const closed = () => { clearTimeout(timer); resolve(); };
      socket.once('close', closed);
      const timer = setTimeout(() => socket.terminate(), CLOSE_TIMEOUT_MS);
      timer.unref();
    });
  }

  private sendControl(message: ClientControl): void {
    if (!this.stopped && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message), { binary: false });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.pongTimer) return;
      this.sendControl({ t: 'ping' });
      this.pongTimer = setTimeout(() => socket.terminate(), PONG_TIMEOUT_MS);
      this.pongTimer.unref();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  private clearHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.pongTimer);
    this.heartbeatTimer = undefined;
    this.pongTimer = undefined;
  }

  private setState(state: ConnectionState): void {
    this.current = state;
    try { this.options.onState?.({ ...state }); } catch { /* Observer failures cannot disrupt cleanup. */ }
  }

  private fail(code: string, message: string): void { this.finish({ status: 'error', code, message }); }

  private finish(state: ConnectionState): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
    this.rejectConnect?.(new Error('Gateway session closed.'));
    this.setState(state);
    for (const waiter of this.waiters) waiter.reject(new Error(state.message ?? 'Gateway session closed.'));
    if (this.socket?.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

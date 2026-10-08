import * as headless from '@xterm/headless';
import * as serializeAddon from '@xterm/addon-serialize';
import type { Terminal as HeadlessTerminal, ITerminalAddon } from '@xterm/headless';
import type { SerializeAddon as TerminalSerializer } from '@xterm/addon-serialize';

// Node ESM exposes these CommonJS packages through default, while the plugin
// bundler can expose their named exports directly because they mark __esModule.
const { Terminal } = (headless as typeof headless & { default?: typeof headless }).default ?? headless;
const { SerializeAddon } = (serializeAddon as typeof serializeAddon & { default?: typeof serializeAddon }).default ?? serializeAddon;

export interface ScreenSnapshot {
  text: string;
  lines: string[];
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  changed: boolean;
  revision: number;
}

type View = Omit<ScreenSnapshot, 'changed' | 'revision'>;
type PendingWrite = { promise: Promise<void>; reject: (reason: Error) => void };

const QUIET_MS = 100;

/** One ANSI terminal per session. ANSI erase/reset commands clear its visible
 * contents normally; reads never clear the screen or another reader's hint.
 * Cursor coordinates are zero-based. Scrollback and color attributes are omitted.
 */
export class Screen {
  private readonly terminal: HeadlessTerminal;
  private readonly serializer: TerminalSerializer;
  private readonly pending = new Set<PendingWrite>();
  private readonly activityListeners = new Set<() => void>();
  private readonly readers = new Map<string, number>();
  private view: View;
  private revision = 0;
  private dirty = false;
  private lastOutputAt = 0;
  private disposed = false;

  constructor(cols = 80, rows = 25, onResponse?: (bytes: Uint8Array) => void) {
    this.validateSize(cols, rows);
    this.terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true, logLevel: 'off' });
    this.serializer = new SerializeAddon();
    // The addon is typed for browser Terminal, but its ANSI serializer uses the
    // shared buffer/modes API implemented by the headless Terminal too.
    this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
    // Only live sessions opt in. A screen used to replay/read output must never
    // send the terminal's automatic query responses back to a server.
    if (onResponse) {
      this.terminal.onData(data => onResponse(new Uint8Array(Buffer.from(data, 'utf8'))));
      // xterm reserves onBinary for legacy mouse reports, encoded as raw bytes.
      this.terminal.onBinary(data => onResponse(new Uint8Array(Buffer.from(data, 'latin1'))));
    }
    this.view = this.capture();
  }

  /** Copy and queue raw UTF-8 bytes. Await this or flush before reading. */
  write(bytes: Uint8Array): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Screen is disposed'));
    if (bytes.byteLength === 0) return Promise.resolve();
    const data = new Uint8Array(bytes);
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const pending = { promise, reject };
    this.pending.add(pending);
    this.lastOutputAt = performance.now();
    this.notifyActivity();
    try {
      this.terminal.write(data, () => {
        if (!this.pending.delete(pending)) return;
        this.lastOutputAt = performance.now();
        this.dirty = true;
        resolve();
        this.notifyActivity();
      });
    } catch (error) {
      this.pending.delete(pending);
      reject(error instanceof Error ? error : new Error(String(error)));
      this.notifyActivity();
    }
    return promise;
  }

  async flush(): Promise<void> {
    this.assertActive();
    while (this.pending.size > 0) {
      await Promise.all([...this.pending].map(write => write.promise));
    }
    this.assertActive();
  }

  /** UTF-8 ANSI replay for a terminal of the same size, beginning with a full
   * reset so existing content/modes cannot leak into the restored screen.
   * Preserves visible buffers, colors/styles, cursor and addon-supported modes.
   * Incomplete input decoder/parser prefixes are not part of serialized state.
   */
  async serialize(): Promise<Uint8Array> {
    await this.flush();
    // A writer may enqueue work between flush resolving and this continuation.
    // Once this check passes, serialization runs without an asynchronous gap.
    while (this.pending.size > 0) await this.flush();
    this.assertActive();
    return new Uint8Array(Buffer.from('\x1bc' + this.serializer.serialize({ scrollback: 0 }), 'utf8'));
  }

  /** Return the last parsed screen. Each reader independently consumes its hint.
   * Writes only mark the view dirty; capture runs here, so unread screens cost nothing. */
  read(readerId = 'default'): ScreenSnapshot {
    this.assertActive();
    this.refresh();
    const changed = this.readers.get(readerId) !== this.revision;
    this.readers.set(readerId, this.revision);
    return { ...this.view, lines: [...this.view.lines], cursor: { ...this.view.cursor }, changed, revision: this.revision };
  }

  resize(cols: number, rows: number): void {
    this.assertActive();
    this.validateSize(cols, rows);
    this.terminal.resize(cols, rows);
    this.dirty = true;
  }

  /** Wait for 100 ms of output quiet, including the initial response window,
   * bounded by waitMs (0..5000). Zero only flushes already queued parser work.
   * Continued output stops waiting at the deadline; abort rejects with AbortError.
   */
  settle(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 5000) {
      return Promise.reject(new RangeError('waitMs must be between 0 and 5000'));
    }
    if (signal?.aborted) return Promise.reject(this.abortError());
    if (this.disposed) return Promise.reject(new Error('Screen is disposed'));
    if (waitMs === 0) return this.flush();
    const startedAt = performance.now();
    const deadline = startedAt + waitMs;
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        this.activityListeners.delete(check);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(this.abortError());
      const check = () => {
        if (finished) return;
        if (timer !== undefined) clearTimeout(timer);
        if (this.disposed) return finish(new Error('Screen is disposed'));
        const now = performance.now();
        const remaining = deadline - now;
        const quietRemaining = Math.max(startedAt, this.lastOutputAt) + QUIET_MS - now;
        if (remaining <= 0 || (quietRemaining <= 0 && this.pending.size === 0)) return finish();
        timer = setTimeout(check, Math.max(1, Math.min(remaining, quietRemaining > 0 ? quietRemaining : remaining)));
      };
      this.activityListeners.add(check);
      signal?.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('Screen is disposed');
    for (const pending of this.pending) pending.reject(error);
    this.pending.clear();
    this.terminal.dispose();
    this.notifyActivity();
    this.activityListeners.clear();
    this.readers.clear();
  }

  private capture(): View {
    const buffer = this.terminal.buffer.active;
    const lines = Array.from({ length: this.terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true).trimEnd() ?? '');
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end--;
    return {
      text: lines.slice(0, end).join('\n'), lines, cols: this.terminal.cols, rows: this.terminal.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
    };
  }

  private refresh(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const next = this.capture();
    if (JSON.stringify(next) !== JSON.stringify(this.view)) {
      this.view = next;
      // Captured lazily on read: a change reverted between two reads leaves `changed` false, which is accurate.
      this.revision++;
    }
  }

  private notifyActivity(): void {
    for (const listener of this.activityListeners) listener();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Screen is disposed');
  }

  private validateSize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
      throw new RangeError('Screen dimensions must be integers between 1 and 1000');
    }
  }

  private abortError(): Error {
    const error = new Error('Screen wait aborted');
    error.name = 'AbortError';
    return error;
  }
}

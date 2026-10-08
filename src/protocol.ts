/** Gateway v1 control frames. Terminal data always uses binary frames. */
export type Auth =
  | { mode: 'register'; secret: string }
  | { mode: 'login'; handle: string; secret: string };

export type ClientControl =
  | { t: 'hello'; v: 1; client: 'bbbbs/0.1.0'; cols: number; rows: number; kind: 'human' | 'agent'; auth: Auth }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'ping' };

export const ERROR_CODES = ['bad_auth', 'handle_taken', 'agents_disabled', 'full', 'banned', 'protocol'] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export type ServerControl =
  | { t: 'registered'; handle: string }
  | { t: 'ready'; handle: string; node: number }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'bye'; reason: 'logoff' | 'idle' | 'kicked' }
  | { t: 'pong' };

export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'registering' | 'ready' | 'reconnecting' | 'error' | 'closed';
  handle?: string;
  node?: number;
  message?: string;
  code?: string;
}

export const MAX_CONTROL_BYTES = 8192;
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export function validateDimensions(cols: number, rows: number): void {
  if (![cols, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 500)) {
    throw new Error('Terminal dimensions must be integers between 1 and 500.');
  }
}

function validHandle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
}

export function validateAuth(auth: Auth, kind: 'human' | 'agent'): void {
  if (!auth || !['login', 'register'].includes(auth.mode) ||
      typeof auth.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(auth.secret) ||
      (auth.mode === 'login' && !validHandle(auth.handle)) ||
      (kind === 'agent' && auth.mode !== 'login')) {
    throw new Error('Invalid gateway credentials.');
  }
}

/** Rebuild objects explicitly so extra gateway fields never reach the UI. */
export function parseServerControl(text: string): ServerControl {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL_BYTES) throw new Error('Control frame is too large.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid gateway control frame.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid gateway control frame.');
  const message = value as Record<string, unknown>;
  switch (message.t) {
    case 'registered':
      if (validHandle(message.handle)) return { t: 'registered', handle: message.handle };
      break;
    case 'ready':
      if (validHandle(message.handle) && Number.isInteger(message.node) &&
          typeof message.node === 'number' && message.node >= 1 && message.node <= 65535) {
        return { t: 'ready', handle: message.handle, node: message.node };
      }
      break;
    case 'error':
      if (ERROR_CODES.includes(message.code as ErrorCode) && typeof message.message === 'string' && message.message.length <= 2000) {
        return { t: 'error', code: message.code as ErrorCode, message: message.message };
      }
      break;
    case 'bye':
      if (message.reason === 'logoff' || message.reason === 'idle' || message.reason === 'kicked') return { t: 'bye', reason: message.reason };
      break;
    case 'pong': return { t: 'pong' };
  }
  throw new Error('Invalid gateway control frame.');
}

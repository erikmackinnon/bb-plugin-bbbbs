import { MAX_KEY_INPUT_BYTES } from './limits.js';

const KEY_SEQUENCES: Readonly<Record<string, string>> = {
  Enter: '\r', Esc: '\x1b', Escape: '\x1b',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
  Backspace: '\x7f', Tab: '\t', Home: '\x1b[H', End: '\x1b[F',
  Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
};

/** UTF-8 literal text followed by named terminal keys, limited in total bytes. */
export function encodeKeys(input: { text?: string; keys?: string[] }): Uint8Array {
  if (input.text !== undefined && typeof input.text !== 'string') throw new TypeError('text must be a string');
  if (input.keys !== undefined && !Array.isArray(input.keys)) throw new TypeError('keys must be an array');
  const chunks = [input.text ?? ''];
  let size = Buffer.byteLength(chunks[0], 'utf8');
  if (size > MAX_KEY_INPUT_BYTES) throw new RangeError(`Input exceeds ${MAX_KEY_INPUT_BYTES} UTF-8 bytes`);
  for (const key of input.keys ?? []) {
    if (typeof key !== 'string') throw new TypeError('Key names must be strings');
    const ctrl = /^Ctrl-([A-Z])$/i.exec(key);
    const sequence = ctrl ? String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) - 64) :
      Object.hasOwn(KEY_SEQUENCES, key) ? KEY_SEQUENCES[key] : undefined;
    if (sequence === undefined) throw new Error(`Unknown key: ${key}`);
    size += Buffer.byteLength(sequence, 'utf8');
    if (size > MAX_KEY_INPUT_BYTES) throw new RangeError(`Input exceeds ${MAX_KEY_INPUT_BYTES} UTF-8 bytes`);
    chunks.push(sequence);
  }
  return new Uint8Array(Buffer.from(chunks.join(''), 'utf8'));
}

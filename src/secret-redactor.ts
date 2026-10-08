const ESC = 0x1b, STAR = 0x2a;
type State = "text" | "esc" | "intermediate" | "csi" | "string" | "string-esc";

/** Mask an ASCII secret printed as terminal text, including occurrences split across frames.
 * Only text bytes can match: escape sequences pass straight through and are never held,
 * so a query such as `ESC [ 6 n` reaches the parser at once. A trailing partial match is
 * held until the next frame decides it, so replay never stores a fragment. Masking keeps
 * the length, so terminal layout is unchanged. `onMatch` fires for every masked occurrence.
 */
export class SecretRedactor {
  private secret: Buffer;
  private held: number[] = [];
  private state: State = "text";
  private ended = false;

  constructor(secret: string, private onMatch: () => void = () => {}) { this.secret = Buffer.from(secret, "utf8"); }

  feed(bytes: Uint8Array): Uint8Array {
    if (this.ended) return bytes;
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: Uint8Array[] = [];
    let index = 0;
    while (index < input.length) {
      if (this.state !== "text") { this.escape(input[index]!); out.push(input.subarray(index, ++index)); continue; }
      if (!this.held.length) {
        // Copy text that cannot start a match in one run.
        const next = Math.min(...[ESC, this.secret[0]!].map((byte) => { const at = input.indexOf(byte, index); return at < 0 ? input.length : at; }));
        if (next > index) out.push(input.subarray(index, next));
        if ((index = next) === input.length) break;
      }
      const byte = input[index++]!;
      if (byte === ESC) { out.push(Uint8Array.from(this.held.splice(0)), Uint8Array.of(byte)); this.state = "esc"; continue; }
      this.held.push(byte);
      const released: number[] = [];
      while (this.held.length && !this.held.every((held, at) => held === this.secret[at])) released.push(this.held.shift()!);
      if (released.length) out.push(Uint8Array.from(released));
      if (this.held.length === this.secret.length) { out.push(Uint8Array.from(this.held.splice(0).fill(STAR))); this.onMatch(); }
    }
    return Buffer.concat(out);
  }

  /** Stop redacting and release any held bytes. */
  end(): Uint8Array {
    this.ended = true;
    return new Uint8Array(this.held.splice(0));
  }

  private escape(byte: number) {
    const state = this.state;
    if (state === "string-esc") { this.state = "esc"; if (byte === 0x5c) { this.state = "text"; return; } }
    if (this.state === "esc") {
      if (byte !== ESC) this.state = byte === 0x5b ? "csi" : [0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(byte) ? "string" : byte >= 0x20 && byte <= 0x2f ? "intermediate" : "text";
    } else if (state === "intermediate") { if (byte >= 0x30) this.state = "text"; }
    else if (state === "csi") { if (byte === ESC) this.state = "esc"; else if ((byte >= 0x40 && byte <= 0x7e) || byte === 0x18 || byte === 0x1a) this.state = "text"; }
    else if (state === "string") { if (byte === 0x07) this.state = "text"; else if (byte === ESC) this.state = "string-esc"; }
  }
}

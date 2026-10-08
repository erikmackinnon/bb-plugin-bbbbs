/** Track whether a raw UTF-8/ANSI stream is at a safe serializer boundary.
 * A snapshot cannot include xterm's partial UTF-8 decoder or ANSI parser state.
 */
export class ReplayBoundary {
  private utf8 = 0;
  private utf8Codepoint = 0;
  private c1 = false;
  private ansi: "ground" | "escape" | "csi" | "osc" | "string" | "string-escape" = "ground";
  private stringKind: "osc" | "string" = "string";
  private escapeSequence = "";
  private csiSequence = "";
  private rows = 25;
  private margins = false;
  private savedCursor = false;
  private cursorHidden = false;
  private customTabs = false;
  private charsets = new Set<string>();
  private shiftedCharset = false;

  resize(rows: number) { this.rows = rows; }

  private escapeComplete(sequence: string) {
    if (sequence === "c") {
      this.margins = this.savedCursor = this.cursorHidden = this.customTabs = this.shiftedCharset = false;
      this.charsets.clear();
      this.c1 = false;
    } else if (sequence === "7") this.savedCursor = true;
    else if (sequence === "H") this.customTabs = true;
    else if (sequence === "n" || sequence === "o") this.shiftedCharset = true;
    else if (/^[()*+\-./][\x30-\x7e]$/.test(sequence)) {
      if (sequence[1] === "B") this.charsets.delete(sequence[0]!);
      else this.charsets.add(sequence[0]!);
    }
  }

  private csiComplete(sequence: string) {
    const final = sequence.at(-1);
    const parameters = sequence.slice(0, -1);
    if (final === "r" && /^[\d;]*$/.test(parameters)) {
      const [top, bottom] = parameters.split(";");
      this.margins = Number(top || 1) !== 1 || Number(bottom || this.rows) !== this.rows;
    } else if (final === "s" && /^[\d;]*$/.test(parameters)) this.savedCursor = true;
    else if (final === "g") this.customTabs = true;
    else if ((final === "h" || final === "l") && parameters.startsWith("?") && parameters.slice(1).split(";").includes("25")) {
      this.cursorHidden = final === "l";
    }
  }

  feed(bytes: Uint8Array): boolean {
    for (const byte of bytes) {
      if (byte >= 0x80) {
        if (byte >= 0xf0 && byte <= 0xf4) { this.utf8 = 3; this.utf8Codepoint = byte & 7; }
        else if (byte >= 0xe0 && byte <= 0xef) { this.utf8 = 2; this.utf8Codepoint = byte & 15; }
        else if (byte >= 0xc2 && byte <= 0xdf) { this.utf8 = 1; this.utf8Codepoint = byte & 31; }
        else if (byte <= 0xbf && this.utf8) {
          this.utf8Codepoint = (this.utf8Codepoint << 6) | (byte & 63);
          if (--this.utf8 === 0 && this.utf8Codepoint >= 0x80 && this.utf8Codepoint <= 0x9f) this.c1 = true;
        }
        else this.utf8 = 0;
        continue;
      }
      this.utf8 = 0;
      if (byte === 0x18 || byte === 0x1a) { this.ansi = "ground"; continue; }
      if (this.ansi === "string-escape") {
        this.ansi = byte === 0x5c ? "ground" : byte === 0x1b ? "string-escape" : this.stringKind;
        continue;
      }
      if (this.ansi === "osc" || this.ansi === "string") {
        if (byte === 0x07 && this.ansi === "osc") this.ansi = "ground";
        else if (byte === 0x1b) { this.stringKind = this.ansi; this.ansi = "string-escape"; }
        continue;
      }
      if (byte === 0x1b) { this.ansi = "escape"; this.escapeSequence = ""; continue; }
      if (this.ansi === "escape") {
        this.escapeSequence += String.fromCharCode(byte);
        if (byte === 0x5b && this.escapeSequence === "[") { this.ansi = "csi"; this.csiSequence = ""; }
        else if (byte === 0x5d) this.ansi = "osc";
        else if ([0x50, 0x58, 0x5e, 0x5f].includes(byte)) this.ansi = "string";
        else if (byte >= 0x30 && byte <= 0x7e) { this.escapeComplete(this.escapeSequence); this.ansi = "ground"; }
      } else if (this.ansi === "csi") {
        if (this.csiSequence.length < 128) this.csiSequence += String.fromCharCode(byte);
        if (byte >= 0x40 && byte <= 0x7e) { this.csiComplete(this.csiSequence); this.ansi = "ground"; }
      } else if (byte === 0x0e) this.shiftedCharset = true;
      else if (byte === 0x0f) this.shiftedCharset = false;
    }
    // SerializeAddon omits these states. Preserve the original raw replay until
    // they return to defaults rather than silently corrupt a door's terminal.
    return this.utf8 === 0 && this.ansi === "ground" && !this.margins && !this.savedCursor
      && !this.cursorHidden && !this.customTabs && !this.charsets.size && !this.shiftedCharset && !this.c1;
  }
}

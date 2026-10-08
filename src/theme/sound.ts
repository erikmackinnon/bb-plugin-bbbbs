/**
 * Synthesised modem noises (WebAudio, no audio files, nothing to license).
 * OFF by default: only create one when the user has turned sound on.
 *
 * Browsers only allow audio after a user gesture. If the context starts
 * suspended (e.g. bb opened the page on its own) everything here quietly
 * plays nothing; it never throws.
 */
export interface ModemSound {
  /** DTMF tones for each digit/letter-ish character of `number`. */
  dial(number: string): Promise<void>;
  /** One North-American ringback burst (440 + 480 Hz). */
  ring(): Promise<void>;
  /** About three seconds of answer tone, bongs and "kshhhhh". */
  handshake(): Promise<void>;
  /** Stops everything and releases the audio context. Idempotent. */
  stop(): void;
}

export interface ModemSoundOptions {
  /** 0..1, default 0.08. Modems are loud; this is not. */
  volume?: number;
}

type AudioCtor = typeof AudioContext;

const DTMF: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};

/** Phone-keypad letters, so "1-800-BBBBS" dials properly. */
function keypadDigit(ch: string): string | null {
  if (ch in DTMF) return ch;
  const pads = ["ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ"];
  const i = pads.findIndex((p) => p.includes(ch.toUpperCase()));
  return i < 0 ? null : String(i + 2);
}

export function createModemSound(options: ModemSoundOptions = {}): ModemSound | null {
  const Ctor: AudioCtor | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext);
  if (!Ctor) return null;

  let ctx: AudioContext | null = new Ctor();
  void ctx.resume().catch(() => {});
  const master = ctx.createGain();
  master.gain.value = options.volume ?? 0.08;
  master.connect(ctx.destination);
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });

  function tone(freqs: number[], start: number, dur: number, type: OscillatorType = "sine", level = 1) {
    if (!ctx) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(level / freqs.length, start + 0.005);
    g.gain.setValueAtTime(level / freqs.length, start + dur - 0.005);
    g.gain.linearRampToValueAtTime(0, start + dur);
    g.connect(master);
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(g);
      o.start(start);
      o.stop(start + dur);
    }
  }

  function noise(start: number, dur: number, centre: number, level = 0.6) {
    if (!ctx) return;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = centre;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = level;
    // the "wobble" of a modem negotiating
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 7;
    lfoGain.gain.value = level * 0.4;
    lfo.connect(lfoGain).connect(g.gain);
    src.connect(bp).connect(g).connect(master);
    src.start(start);
    lfo.start(start);
    src.stop(start + dur);
    lfo.stop(start + dur);
  }

  return {
    async dial(number) {
      if (!ctx) return;
      let t = ctx.currentTime + 0.05;
      for (const ch of number) {
        const d = keypadDigit(ch);
        if (!d) continue;
        tone(DTMF[d], t, 0.09);
        t += 0.15;
      }
      await wait((t - ctx.currentTime) * 1000);
    },
    async ring() {
      if (!ctx) return;
      tone([440, 480], ctx.currentTime + 0.02, 1.2, "sine", 0.7);
      await wait(1900);
    },
    async handshake() {
      if (!ctx) return;
      const t = ctx.currentTime + 0.02;
      tone([2100], t, 0.9, "sine", 0.8); //               answer tone
      tone([1200], t + 1.0, 0.18, "square", 0.25); //     bong
      tone([2400], t + 1.2, 0.18, "square", 0.25); //     bing
      tone([980, 1650], t + 1.45, 0.35, "sine", 0.6); //  V.21-ish chirp
      noise(t + 1.85, 1.3, 1800, 0.7); //                 kshhhhhhh
      tone([1800], t + 1.85, 1.3, "triangle", 0.15);
      await wait(3300);
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      const c = ctx;
      ctx = null;
      if (c) void c.close().catch(() => {});
    },
  };
}

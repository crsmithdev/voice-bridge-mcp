/**
 * PCM in and out of the voice path.
 *
 * The desk loop of 7.3 let sox find the ends of a turn. LiveKit hands the
 * bridge frames instead of a device, so the same rule of 11.5 lives here: wait
 * for the level to come up, then end the turn on the pause after it.
 *
 * The pre-roll is why this is better than the sox version. sox throws away the
 * audio it spends deciding that speech started, which ate the first word of a
 * sentence. Here that audio is kept.
 */

export interface Wav {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

/** Piper writes plain 16-bit PCM, so only that is read. */
export function decodeWav(bytes: Uint8Array): Wav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x52494646) throw new Error("not a RIFF file");
  let at = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (at + 8 <= bytes.length) {
    const id = view.getUint32(at, false);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 0x666d7420) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (bits !== 16) throw new Error(`only 16-bit PCM is read, not ${bits}-bit`);
    } else if (id === 0x64617461) {
      return { sampleRate, channels, samples: new Int16Array(bytes.buffer.slice(bytes.byteOffset + body, bytes.byteOffset + body + size)) };
    }
    at = body + size + (size % 2);
  }
  throw new Error("the file has no data chunk");
}

export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.byteLength, true);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return out;
}

/** The level of a block of samples, as a fraction of full scale. */
export function level(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length) / 32768;
}

export interface UtteranceOptions {
  sampleRate: number;
  /** 11.5 the pause that ends a turn */
  pauseMs: number;
  /** how long the level must stay up before this counts as speech */
  onsetMs: number;
  /** the level that counts as speech, as a fraction of full scale */
  speechLevel: number;
}

/**
 * Frames in, whole utterances out (11.5). Nothing is emitted while Chris is
 * still talking, and nothing at all while the room is quiet.
 */
export class Utterances {
  private recording: Int16Array[] = [];
  private preRoll: Int16Array[] = [];
  private preRollSamples = 0;
  private loudMs = 0;
  private quietMs = 0;
  private speaking = false;

  constructor(private readonly options: UtteranceOptions) {}

  private get preRollLimit(): number {
    return Math.round((this.options.onsetMs + 200) * this.options.sampleRate / 1000);
  }

  /** The utterance this frame completed, or null. */
  push(frame: Int16Array): Int16Array | null {
    const { sampleRate, pauseMs, onsetMs, speechLevel } = this.options;
    const ms = (frame.length / sampleRate) * 1000;
    const loud = level(frame) >= speechLevel;

    if (!this.speaking) {
      // keep a little of what came before, so the first word survives the decision
      this.preRoll.push(frame);
      this.preRollSamples += frame.length;
      while (this.preRollSamples > this.preRollLimit && this.preRoll.length > 1) {
        this.preRollSamples -= (this.preRoll.shift() as Int16Array).length;
      }
      this.loudMs = loud ? this.loudMs + ms : 0;
      if (this.loudMs < onsetMs) return null;
      this.speaking = true;
      this.recording = [...this.preRoll];
      this.preRoll = [];
      this.preRollSamples = 0;
      this.quietMs = 0;
      return null;
    }

    this.recording.push(frame);
    this.quietMs = loud ? 0 : this.quietMs + ms;
    if (this.quietMs < pauseMs) return null;
    const utterance = concat(this.recording);
    this.reset();
    return utterance;
  }

  /** Anything held when the stream ends is still an utterance. */
  flush(): Int16Array | null {
    if (!this.speaking) return null;
    const utterance = concat(this.recording);
    this.reset();
    return utterance;
  }

  reset(): void {
    this.recording = [];
    this.preRoll = [];
    this.preRollSamples = 0;
    this.loudMs = 0;
    this.quietMs = 0;
    this.speaking = false;
  }

  /** 11.3 whether Chris is talking right now, which is what stops the playback. */
  get active(): boolean {
    return this.speaking;
  }
}

function concat(blocks: Int16Array[]): Int16Array {
  let total = 0;
  for (const block of blocks) total += block.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const block of blocks) { out.set(block, at); at += block.length; }
  return out;
}

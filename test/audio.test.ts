import { describe, expect, test } from "bun:test";
import { Utterances, decodeWav, encodeWav, level } from "../src/audio.ts";

const RATE = 16_000;
/** 20 ms of frame, the size LiveKit hands over. */
function frame(amplitude: number, ms = 20): Int16Array {
  const out = new Int16Array((RATE * ms) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin(i / 4) * amplitude * 32767);
  return out;
}
const LOUD = frame(0.3);
const QUIET = frame(0.0001);

function collector() {
  return new Utterances({ sampleRate: RATE, pauseMs: 200, onsetMs: 40, speechLevel: 0.02 });
}

describe("wav", () => {
  test("what is written is what is read back", () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const wav = decodeWav(encodeWav(samples, 22050));
    expect(wav.sampleRate).toBe(22050);
    expect(wav.channels).toBe(1);
    expect(Array.from(wav.samples)).toEqual(Array.from(samples));
  });
  test("a file that is not a wav is refused rather than misread", () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow("not a RIFF file");
  });
});

describe("level", () => {
  test("silence is nothing and speech is not", () => {
    expect(level(QUIET)).toBeLessThan(0.02);
    expect(level(LOUD)).toBeGreaterThan(0.02);
    expect(level(new Int16Array(0))).toBe(0);
  });
});

describe("utterances (11.5)", () => {
  test("a quiet room produces nothing at all", () => {
    const u = collector();
    for (let i = 0; i < 100; i++) expect(u.push(QUIET)).toBeNull();
    expect(u.active).toBe(false);
  });
  test("speech ends on the pause after it, not during it", () => {
    const u = collector();
    for (let i = 0; i < 20; i++) u.push(LOUD);
    expect(u.active).toBe(true);
    // 200 ms of pause is 10 frames of 20 ms; the ninth must not end the turn
    for (let i = 0; i < 9; i++) expect(u.push(QUIET)).toBeNull();
    const said = u.push(QUIET);
    expect(said).not.toBeNull();
    expect(u.active).toBe(false);
  });
  test("the pause resets when Chris starts again, so a comma does not end the turn", () => {
    const u = collector();
    for (let i = 0; i < 20; i++) u.push(LOUD);
    for (let i = 0; i < 5; i++) u.push(QUIET);
    u.push(LOUD);
    for (let i = 0; i < 9; i++) expect(u.push(QUIET)).toBeNull();
    expect(u.push(QUIET)).not.toBeNull();
  });
  test("the audio before the decision is kept, so the first word survives", () => {
    const u = collector();
    for (let i = 0; i < 5; i++) u.push(QUIET);
    for (let i = 0; i < 20; i++) u.push(LOUD);
    let said: Int16Array | null = null;
    for (let i = 0; i < 10 && !said; i++) said = u.push(QUIET);
    // the frames it took to decide speech had started are in there, not thrown away
    expect(said).not.toBeNull();
    expect((said as Int16Array).length).toBeGreaterThan(20 * LOUD.length);
  });
  test("what is held when the stream ends is still an utterance", () => {
    const u = collector();
    for (let i = 0; i < 20; i++) u.push(LOUD);
    expect(u.flush()).not.toBeNull();
    expect(u.flush()).toBeNull();
  });
});

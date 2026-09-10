/**
 * Audible state (spec section 15). Silence is ambiguous: when the bridge
 * cannot answer yet, it says so with a sound rather than with nothing (15.1).
 *
 * The cue is a soft two-note figure, like a telephone hold tone (15.3), and it
 * only starts after a delay, so an ordinary wait stays quiet (15.5). Different
 * states use different notes, so Chris can tell them apart without words
 * (15.4).
 */
import { join } from "node:path";

export type CueName = "thinking" | "starting";

/** Low and calm for a turn in progress; a rising pair for a process coming up. */
const NOTES: Record<CueName, [number, number]> = {
  thinking: [392, 330],
  starting: [330, 494],
};

export class Cues {
  private files = new Map<CueName, string>();

  constructor(private readonly dir: string) {}

  /** 15.6 pleasant and calm: quiet, short, and faded at both ends so it never clicks. */
  async build(): Promise<void> {
    for (const [name, [first, second]] of Object.entries(NOTES) as Array<[CueName, [number, number]]>) {
      const wav = join(this.dir, `cue-${name}.wav`);
      const done = await Bun.spawn([
        // -b 16 -e signed-integer is not optional: sox writes 32-bit float by
        // default, which plays locally and is refused by the wav reader that
        // feeds the transport.
        "sox", "-n", "-r", "22050", "-c", "1", "-b", "16", "-e", "signed-integer", wav,
        "synth", "0.16", "sine", String(first),
        ":", "synth", "0.20", "sine", String(second),
        "fade", "q", "0.03", "0", "0.08", "vol", "0.12",
      ], { stdout: "ignore", stderr: "ignore" }).exited;
      if (done === 0) this.files.set(name, wav);
    }
  }

  /** The file, for a transport that sends bytes rather than plays them. */
  file(name: CueName): string | undefined {
    return this.files.get(name);
  }

  async play(name: CueName): Promise<void> {
    const wav = this.files.get(name);
    if (!wav) return;
    await Bun.spawn(["paplay", wav], { stdout: "ignore", stderr: "ignore" }).exited;
  }
}

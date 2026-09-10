/**
 * A phone, without the phone.
 *
 * It pairs the way the client does, joins the room, speaks with the same local
 * voice the bridge uses, and transcribes what the bridge says back. So a spoken
 * conversation can be driven from a script and asserted on, with no hardware
 * and nobody talking.
 *
 *   bun scripts/fake-phone.ts "what is two plus two" "say the word done"
 *   bun scripts/fake-phone.ts --dir ~/some-project "summarise the readme"
 *   bun scripts/fake-phone.ts --barge 4000 "list twenty primes" "stop, different question"
 *   bun scripts/fake-phone.ts --attach https://host:3100#amber-cedar-tide "hello"
 *
 * It starts a bridge of its own, on a free port and in a room of its own, and
 * stops it at the end. That matters: there is one long-lived room in normal
 * use, and a test client that joins it turns up in the real conversation.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Utterances, encodeWav } from "../src/audio.ts";
import { loadConfig } from "../src/config.ts";
import { LocalPiper, LocalWhisper } from "../src/speech.ts";
import { RTC_RATE, Transport } from "../src/transport.ts";

interface Options {
  dir: string;
  attach: string;
  bargeMs: number;
  quietMs: number;
  lines: string[];
}

function parse(argv: string[]): Options {
  const options: Options = { dir: "/tmp", attach: "", bargeMs: 0, quietMs: 25_000, lines: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--dir") options.dir = argv[++i] as string;
    else if (arg === "--attach") options.attach = argv[++i] as string;
    else if (arg === "--barge") options.bargeMs = Number(argv[++i]);
    else if (arg === "--wait") options.quietMs = Number(argv[++i]);
    else options.lines.push(arg);
  }
  return options;
}

const options = parse(process.argv.slice(2));
if (options.lines.length === 0) {
  console.error('usage: bun scripts/fake-phone.ts [--dir <project>] [--barge <ms>] [--attach <url>#<code>] "a thing to say" ...');
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "fake-phone-"));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;

/** A bridge of its own, so this never turns up in the real conversation. */
async function ownBridge(): Promise<{ base: string; code: string; stop: () => void }> {
  const port = 3200 + Math.floor(Math.random() * 300);
  const room = `test-${Date.now()}`;
  const config = {
    ...loadConfig(),
    servePort: port,
    room,
    // plain http on loopback: this client is not a browser, so it needs no
    // secure context, and the real certificate does not match 127.0.0.1
    tlsCert: "", tlsKey: "",
    publicOrigin: `http://127.0.0.1:${port}`,
    livekitPublicUrl: `ws://127.0.0.1:7880`,
  };
  const path = join(scratch, "config.json");
  await Bun.write(path, JSON.stringify(config));
  const child = Bun.spawn(["bun", "src/main.ts", "serve", options.dir], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, VOICE_BRIDGE_CONFIG: path },
    stdout: "pipe", stderr: "pipe",
  });

  // Everything the bridge says, both streams, prefixed. A test rig that hides
  // the other side's stderr is a test rig that wastes an afternoon.
  let code = "";
  const seen = Promise.withResolvers<string>();
  const drain = async (stream: ReadableStream<Uint8Array>, label: string) => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim() || line.includes('"name":"lk-rtc"') || line.includes("Nvidia Decoder")) continue;
        console.log(`${at()} ${label} | ${line.trim()}`);
        const found = /pair the phone with this code: (\S+)/.exec(line);
        if (found) { code = found[1] as string; seen.resolve(code); }
      }
    }
  };
  void drain(child.stdout as ReadableStream<Uint8Array>, "bridge");
  void drain(child.stderr as ReadableStream<Uint8Array>, "bridge!");
  const ready = await Promise.race([
    seen.promise,
    Bun.sleep(90_000).then(() => ""),
  ]);
  if (!ready) { console.error("the bridge never printed a pairing code"); child.kill(); process.exit(1); }

  return { base: `http://127.0.0.1:${port}`, code, stop: () => child.kill() };
}

const bridge = options.attach
  ? { base: options.attach.split("#")[0] as string, code: options.attach.split("#")[1] ?? "", stop: () => {} }
  : await ownBridge();
console.log(`${at()} paired against ${bridge.base}`);

const paired = await fetch(`${bridge.base}/pair`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: bridge.code }),
});
if (!paired.ok) { console.error("pairing failed:", await paired.text()); bridge.stop(); process.exit(1); }
const credentials = await paired.json() as { token: string; url: string; room: string };

const config = loadConfig();
const speechDir = new URL("../speech", import.meta.url).pathname;
const tts = new LocalPiper(config, speechDir);
const stt = new LocalWhisper(config, speechDir);
await Promise.all([tts.start(), stt.start()]);

const phone = new Transport();
await phone.connect(credentials.url, credentials.token, "fake-phone");
console.log(`${at()} joined ${credentials.room} and opened the microphone`);
// The bridge subscribes a moment after the track appears, and anything said
// before that is said to nobody. A person opening the page never notices;
// a script that speaks immediately loses its first line every time.
await Bun.sleep(3_000);

/** What the bridge said, heard the way the phone hears it. */
const heard: string[] = [];
let speakingSince = 0;
let lastAudioAt = 0;
const utterances = new Utterances({ sampleRate: RTC_RATE, pauseMs: 900, onsetMs: 80, speechLevel: 0.02 });
let index = 0;
phone.onAudio((frame) => {
  for (const sample of frame) {
    if (Math.abs(sample) > 800) { if (!speakingSince) speakingSince = Date.now(); lastAudioAt = Date.now(); break; }
  }
  const said = utterances.push(frame);
  if (!said) return;
  const wav = join(scratch, `heard-${++index}.wav`);
  void Bun.write(wav, encodeWav(said, RTC_RATE))
    .then(() => stt.transcribe(wav))
    .then((text) => { if (text) { heard.push(text); console.log(`${at()} heard  | ${text}`); } });
});
phone.onMessage((value) => {
  if (value.kind === "narration") console.log(`${at()} note   | ${String(value.text)}`);
});

/** Speak a line the way a person would: as sound, not as text. */
async function say(text: string): Promise<void> {
  const wav = join(scratch, `say-${index}-out.wav`);
  await tts.synthesize(text, wav);
  console.log(`${at()} said   | ${text}`);
  await phone.speak(await Bun.file(wav).bytes());
}

const measurements: string[] = [];
for (const [n, line] of options.lines.entries()) {
  const bargeIn = options.bargeMs > 0 && n > 0;
  if (!bargeIn) {
    speakingSince = 0;
    const askedAt = Date.now();
    await say(line);
    // wait for the bridge to answer and then go quiet
    const deadline = Date.now() + options.quietMs;
    while (Date.now() < deadline) {
      await Bun.sleep(250);
      if (speakingSince && Date.now() - lastAudioAt > 2_000) break;
    }
    measurements.push(speakingSince
      // from the end of the audio, so it includes the end-of-turn pause of 11.5
      ? `line ${n + 1}: first audio ${((speakingSince - askedAt) / 1000).toFixed(1)}s after the question ended, pause included`
      : `line ${n + 1}: the bridge said nothing`);
  } else {
    // 11.3 talk over the bridge, once it is well into its answer
    await Bun.sleep(options.bargeMs);
    const startedAt = Date.now();
    await say(line);
    await Bun.sleep(3_000);
    measurements.push(`line ${n + 1}: interrupted; the bridge went quiet ${((lastAudioAt - startedAt) / 1000).toFixed(1)}s after`);
  }
}

await Bun.sleep(1_500);
console.log("\n--- what the bridge said");
for (const line of heard) console.log(`  ${line}`);
console.log("--- measurements (18.4)");
for (const line of measurements) console.log(`  ${line}`);

await phone.close();
tts.stop(); stt.stop();
bridge.stop();
process.exit(0);

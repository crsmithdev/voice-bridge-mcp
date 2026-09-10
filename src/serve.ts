/**
 * The bridge as a LiveKit participant, and the small server that lets a phone
 * reach it (spec 7.4, 12).
 *
 * The audio never touches the machine's own devices here. The phone opens the
 * microphone, LiveKit carries the frames, and the framework cancels the echo at
 * the client (4.2), so the bridge can keep listening while it speaks. That is
 * what makes barge-in possible at all (11.1 to 11.3), and it is why 11.4 says
 * not to hand-build a canceller.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Utterances, encodeWav } from "./audio.ts";
import type { Config } from "./config.ts";
import { Conversation } from "./conversation.ts";
import { Cues } from "./cues.ts";
import { LocalPiper, LocalWhisper } from "./speech.ts";
import { advertiseHost, livekitConfig, loadOrCreateKeys } from "./keys.ts";
import { RTC_RATE, Transport, tokenFor } from "./transport.ts";

/** 12.2 one pairing, then a long-lived token the client keeps. */
function pairingCode(): string {
  const words = "amber,anchor,basalt,cedar,cobalt,dust,ember,fathom,garnet,harbour,indigo,jetty,kelp,lantern,marlin,north,onyx,pewter,quartz,rigging,slate,tide,umber,vellum,willow,zenith".split(",");
  return [0, 0, 0].map(() => words[Math.floor(Math.random() * words.length)]).join("-");
}

/** What the phone must be told, which is never what the bridge itself dials. */
export function endpoints(config: Config) {
  const stored = loadOrCreateKeys();
  const host = config.advertiseHost || advertiseHost();
  const secure = Boolean(config.tlsCert && config.tlsKey);
  const scheme = secure || config.publicOrigin.startsWith("https:") ? "https" : "http";
  return {
    host,
    secure,
    keys: {
      apiKey: config.livekitApiKey || stored.apiKey,
      apiSecret: config.livekitApiSecret || stored.apiSecret,
      // the bridge is on the same machine as the server, so it dials the loopback
      url: config.livekitUrl || `ws://127.0.0.1:${config.livekitPort}`,
    },
    // the phone is not, so it is given what reaches this machine from outside
    origin: config.publicOrigin || `${scheme}://${host}:${config.servePort}`,
    // an https page may not open a ws:// socket, so this must be wss when it is
    clientUrl: config.livekitPublicUrl || `${scheme === "https" ? "wss" : "ws"}://${host}:${config.livekitPort}`,
  };
}

export async function serve(dir: string, config: Config): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "voice-bridge-"));
  const { host, keys, clientUrl, origin, secure } = endpoints(config);
  const speechDir = new URL("../speech", import.meta.url).pathname;
  const stt = new LocalWhisper(config, speechDir);
  const tts = new LocalPiper(config, speechDir);
  const cues = new Cues(scratch);
  await Promise.all([stt.start(), tts.start(), cues.build()]);

  const transport = new Transport();
  await transport.join(keys, config.room);

  let counter = 0;
  /** 11.5 the ends of a turn, found in the frames the phone sends. */
  const utterances = new Utterances({
    sampleRate: RTC_RATE,
    pauseMs: config.endOfTurnPauseMs,
    onsetMs: config.speechOnsetMs,
    speechLevel: config.speechLevel,
  });

  const conversation = new Conversation(dir, config, {
    async say(text: string): Promise<void> {
      const wav = join(scratch, `say-${++counter}.wav`);
      await tts.synthesize(text, wav);
      console.log(`  ${text}`);
      // 11.3 stop the moment Chris starts to talk. The frames cannot hold the
      // bridge's own voice, because the client cancelled it before sending.
      const whole = await transport.speak(await Bun.file(wav).bytes(), () => utterances.active);
      if (!whole) console.log(`  [stopped: Chris started talking${bargedAt ? `, ${Date.now() - bargedAt}ms after it was noticed` : ""}]`);
    },
    cue(name) {
      const wav = cues.file(name);
      if (!wav) return;
      void Bun.file(wav).bytes()
        .then((bytes) => transport.speak(bytes, () => utterances.active))
        .catch((error) => console.log(`[the cue failed: ${(error as Error).message}]`));
    },
    tell(value) { void transport.send(value); },
  }, stt, tts, {
    onNarration: (text) => { console.log(`[${text}]`); void transport.send({ kind: "narration", text }); },
    onTurn: (turn) => console.log(`[turn ${turn.number}, $${conversation.session.totalCostUsd().toFixed(4)} this session]`),
  });
  conversation.start();

  let wasActive = false;
  let bargedAt = 0;
  // 14.8 a client that dropped in a tunnel gets the turns it missed on the way back
  transport.onParticipant(() => {
    void transport.send({ kind: "history", turns: conversation.missed() });
  });

  transport.onAudio((frame) => {
    const said = utterances.push(frame);
    // 11.3 the moment Chris starts, the bridge stops — every sentence, not one
    if (utterances.active !== wasActive) {
      wasActive = utterances.active;
      if (wasActive) { bargedAt = Date.now(); conversation.stopSpeaking(); }
    }
    if (!said) return;
    const wav = join(scratch, `heard-${++counter}.wav`);
    void Bun.write(wav, encodeWav(said, RTC_RATE))
      .then(() => stt.transcribe(wav))
      .then((text) => {
        if (!text) return;
        console.log(`\n> ${text}`);
        return conversation.heard(text);
      })
      .catch((error) => console.log(`[could not read that: ${(error as Error).message}]`));
  });

  // 9.4.8 and 10.2 also reach the bridge as typed text from the client, because
  // a car is loud and a button is sometimes the honest way to say a thing.
  transport.onMessage((value) => {
    if (value.kind === "said" && typeof value.text === "string") void conversation.heard(value.text);
  });

  const code = pairingCode();
  const page = await Bun.file(new URL("../client/index.html", import.meta.url).pathname).text();
  const sdk = new URL("../node_modules/livekit-client/dist/livekit-client.esm.mjs", import.meta.url).pathname;

  const server = Bun.serve({
    port: config.servePort,
    hostname: "0.0.0.0",
    ...(secure ? { tls: { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) } } : {}),
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/livekit-client.mjs") return new Response(Bun.file(sdk), { headers: { "content-type": "text/javascript" } });
      // 12.1 the boundary. Everything below here needs the code or a token.
      if (url.pathname === "/pair" && request.method === "POST") {
        const body = await request.json().catch(() => ({})) as { code?: string };
        if (body.code?.trim().toLowerCase() !== code) return Response.json({ error: "that code is not right" }, { status: 403 });
        const token = await tokenFor(keys, config.room, `phone-${Date.now()}`, config.tokenDays * 24);
        // 12.3 the same answer serves the web client and the Android app. The url
        // is the one the phone can reach, never the loopback the bridge dials.
        return Response.json({ token, url: clientUrl, room: config.room });
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`bridge on ${origin}, room ${config.room}, Claude Code in ${dir}`);
  console.log(`the phone reaches LiveKit at ${clientUrl}`);
  if (origin.startsWith("http://") && !origin.includes("127.0.0.1") && !origin.includes("localhost")) {
    // saying this plainly here is cheaper than finding it on the phone
    console.log("warning: a browser gives no microphone to a page that is not https, except on loopback");
  }
  console.log(`pair the phone with this code: ${code}`);
  await new Promise(() => {});
}

export { livekitConfig };

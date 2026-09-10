#!/usr/bin/env bun
/**
 * The text round trip (spec 7.2). Voice comes at 7.3; this loop is useful on
 * its own, and it is where the process management gets tested.
 *
 *   bun src/main.ts chat <project-dir>    a spoken conversation, typed
 *   bun src/main.ts config                the settings and where they come from
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configPath, loadConfig, type Config } from "./config.ts";
import { SentenceCollector } from "./sentences.ts";
import { Session } from "./session.ts";
import { match, type CommandName } from "./commands.ts";
import { Cues } from "./cues.ts";
import { LocalPiper, LocalWhisper } from "./speech.ts";

function showConfig(config: Config): void {
  console.log(`config: ${configPath()}`);
  for (const [key, value] of Object.entries(config)) {
    const isDefault = JSON.stringify(value) === JSON.stringify(DEFAULTS[key as keyof Config]);
    console.log(`  ${key} = ${JSON.stringify(value)}${isDefault ? "" : "   (set)"}`);
  }
}

async function chat(dir: string, config: Config): Promise<void> {
  // 5.5 the reply arrives word by word. Here it goes straight to the terminal;
  // at 7.3 the same hook feeds the sentence collector of 5.6.
  let streamed = false;
  const session = new Session(dir, config, {
    onDelta: (text) => { streamed = true; process.stdout.write(text); },
    // 2.3 at 7.3 this is spoken; here it keeps a long turn from looking hung
    onNarration: (text) => console.log(`[${text}]`),
    onCheckpoint: (ms) => console.log(`\n[this turn has run ${Math.round(ms / 60_000)} minutes. say "${config.agreementWord}" to let it run]`),
    onInterrupt: (reason) => console.log(`\n[interrupting the turn: ${reason}]`),
    onRestart: (reason) => console.log(`\n[restarting Claude Code: ${reason}]`),
  });
  session.start();
  console.log(`Claude Code in ${dir}, model ${config.model}. Ctrl-D to leave.`);

  for await (const line of console) {
    const text = line.trim();
    if (!text) continue;
    // 8.6.4 the agreement word is heard here in text, and by voice at 7.3
    if (text.toLowerCase() === config.agreementWord.toLowerCase()) { session.agree(); console.log("[continuing]"); continue; }
    try {
      streamed = false;
      const turn = await session.ask(text);
      console.log(streamed ? "\n" : `\n${turn.text}\n`);
      const fraction = session.contextFraction();
      const context = fraction === null ? "" : `, context ${Math.round(fraction * 100)}% of the compaction threshold`;
      console.log(`[turn ${turn.number}, $${session.totalCostUsd().toFixed(4)} this session${context}]`);
    } catch (error) {
      console.log(`\n[${(error as Error).message}]`);
    }
  }
  session.stop();
}

/**
 * 5.1-5.2 the microphone, with the end of a turn found by the pause after it
 * (11.5). The recorder starts when the level comes up and stops itself after
 * the pause, so one call is one thing Chris said.
 */
function recorder(wav: string, config: Config) {
  const onset = (config.speechOnsetMs / 1000).toFixed(2);
  const pause = (config.endOfTurnPauseMs / 1000).toFixed(2);
  const record = `parecord --raw --channels=1 --rate=16000 --format=s16le 2>/dev/null` +
    ` | sox -t raw -r 16000 -e signed -b 16 -c 1 - ${wav}` +
    ` silence 1 ${onset} ${config.silenceThreshold} 1 ${pause} ${config.silenceThreshold}`;
  return Bun.spawn(["bash", "-c", record], { stdout: "ignore", stderr: "ignore" });
}

/** 5.9 play one sentence. Sentences are played in order, never on top of each other. */
async function play(wav: string): Promise<void> {
  await Bun.spawn(["paplay", wav], { stdout: "ignore", stderr: "ignore" }).exited;
}

/** VOICE_BRIDGE_DEBUG=1 traces the microphone, which is the part that cannot be watched. */
const trace = process.env.VOICE_BRIDGE_DEBUG
  ? (text: string) => console.log(`    . ${new Date().toISOString().slice(14, 22)} ${text}`)
  : () => {};

/** 7.3 the spoken loop, on top of the text loop of 7.2. */
async function voice(dir: string, config: Config): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "voice-bridge-"));
  const speechDir = new URL("../speech", import.meta.url).pathname;
  const stt = new LocalWhisper(config, speechDir);
  const tts = new LocalPiper(config, speechDir);
  const cues = new Cues(scratch);

  // 4.6 and 4.9 both cost seconds to load, so the cost is paid before the first word
  const startedAt = Date.now();
  await Promise.all([stt.start(), tts.start(), cues.build()]);
  console.log(`voice ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${config.sttModel} and ${config.ttsVoice}, both local`);

  let muted = false;
  let turnRunning = false;
  let checkpointOpen = false;
  let lastReply = "";
  let counter = 0;
  /** Bumped whenever the bridge speaks, so a recording that overlapped is thrown away. */
  let speech = 0;
  /**
   * How many sentences are queued or playing. This counts the whole queue, not
   * one sentence: a per-sentence flag falls to false in the gap between two
   * sentences, the microphone opens there, and the bridge transcribes its own
   * voice and answers it. That happened, and it costs a turn every time.
   */
  let pending = 0;
  const recent: Array<{ said: string; reply: string }> = [];
  let deltaSink: ((text: string) => void) | null = null;

  /** The recording in flight, so anything the bridge plays can cut it short. */
  let listening: ReturnType<typeof recorder> | null = null;

  /**
   * Every sound the bridge makes stops the microphone first. Without this a
   * single recording spans the bridge's own voice and the answer to it, and the
   * whole recording is then thrown away as self-heard: the checkpoint asks for
   * the agreement word and cannot hear it.
   */
  function takeTheMicrophone(): void {
    speech += 1;
    pending += 1;
    try { listening?.kill(); } catch { /* already gone */ }
    listening = null;
  }

  /** 5.7-5.9 one sentence at a time, in order, never on top of each other. */
  let queue: Promise<void> = Promise.resolve();
  function say(text: string): void {
    const wav = join(scratch, `say-${++counter}.wav`);
    takeTheMicrophone();
    queue = queue.then(async () => {
      console.log(`  ${text}`);
      await tts.synthesize(text, wav);
      await play(wav);
    }).catch((error) => console.log(`[the voice failed: ${(error as Error).message}]`))
      .finally(() => { pending -= 1; });
  }

  /**
   * A cue does not take the microphone. It is a tone: the voice detector drops
   * it and no transcription can mistake it for words, so it may sit inside a
   * recording that also holds what Chris said. Only the voice has to cut the
   * microphone, because only the voice can be transcribed back as a question.
   */
  function cue(name: "thinking" | "starting"): void {
    void cues.play(name);
  }

  // 6.5 the voice instruction lives here, not in the agent's identity file
  const session = new Session(dir, { ...config, claudeArgs: [...config.claudeArgs, "--append-system-prompt", config.voiceInstruction] }, {
    onDelta: (text) => deltaSink?.(text),
    onNarration: (text) => console.log(`[${text}]`),
    // 8.6.3 speak, say how long it has run, and report the usage with the ask (8.6.4)
    onCheckpoint: (ms) => {
      checkpointOpen = true;
      say(`This turn has run ${Math.round(ms / 60_000)} minutes and cost ${session.totalCostUsd().toFixed(2)} dollars. Say ${config.agreementWord} to let it run on.`);
    },
    onInterrupt: () => { checkpointOpen = false; },
    onRestart: (reason) => { cue("starting"); console.log(`[restarting Claude Code: ${reason}]`); },
  });
  session.start();
  console.log(`Claude Code in ${dir}. Speak; a ${(config.endOfTurnPauseMs / 1000).toFixed(1)}s pause ends your turn.`);
  console.log(`Say "${config.wakeWord}" then a command. Ctrl-C to leave.`);

  /** 15.1 a wait must not be silence. 15.5 only once the wait is long enough. */
  function cueWhileWaiting(): () => void {
    let timer = setTimeout(function tick() {
      // never over the top of the voice, and never while an answer is wanted:
      // at the checkpoint the bridge has just asked a question and is listening
      if (pending === 0 && !checkpointOpen) { trace("cue"); cue("thinking"); }
      timer = setTimeout(tick, config.audioCueEveryMs);
    }, config.audioCueDelayMs);
    return () => clearTimeout(timer);
  }

  async function runTurn(said: string): Promise<void> {
    turnRunning = true;
    const sentences = new SentenceCollector(config.sentenceMaxChars);
    const spokenParts: string[] = [];
    deltaSink = (text) => {
      for (const sentence of sentences.push(text)) { spokenParts.push(sentence); say(sentence); }
    };
    const stopCue = cueWhileWaiting();
    try {
      const reply = await session.ask(said);
      const tail = sentences.flush();
      if (tail) { spokenParts.push(tail); say(tail); }
      await queue;
      lastReply = spokenParts.join(" ") || reply.text;
      recent.push({ said, reply: lastReply });
      if (recent.length > 3) recent.shift();
      console.log(`[turn ${reply.number}, $${session.totalCostUsd().toFixed(4)} this session]`);
      // 13.2 the warning uses the number claude reports, never an estimate (16.6)
      const worst = Math.max(session.rateLimit.fiveHour, session.rateLimit.sevenDay);
      if (worst >= config.usageWarnFraction) say(`A heads up: rate limit use is at ${Math.round(worst * 100)} percent.`);
    } catch (error) {
      say("That turn did not finish.");
      console.log(`[${(error as Error).message}]`);
    } finally {
      stopCue();
      deltaSink = null;
      turnRunning = false;
      checkpointOpen = false;
    }
  }

  /** 9.4 the commands. Each one answers out loud, because silence is ambiguous (15.1). */
  async function run(name: CommandName): Promise<void> {
    switch (name) {
      case "mute": muted = true; say("Muted."); break;
      case "unmute": muted = false; say("Listening."); break;
      // 8.8 a fresh process is a fresh context
      case "clearContext": session.restart("cleared by voice"); say("Context cleared."); break;
      case "usage": {
        const context = session.contextFraction();
        const parts = [`This session has cost ${session.totalCostUsd().toFixed(2)} dollars.`];
        if (session.rateLimit.fiveHour || session.rateLimit.sevenDay) {
          parts.push(`Rate limit use is ${Math.round(session.rateLimit.fiveHour * 100)} percent of the five hour window and ${Math.round(session.rateLimit.sevenDay * 100)} percent of the seven day window.`);
        }
        if (context !== null) parts.push(`The context is ${Math.round(context * 100)} percent of the compaction threshold.`);
        for (const part of parts) say(part);
        break;
      }
      case "restate": say(lastReply || "There is nothing to restate yet."); break;
      case "summarize":
        if (!lastReply) { say("There is nothing to summarize yet."); break; }
        void runTurn("Summarize your last answer in one short spoken sentence.");
        break;
      // 9.4.7 the bridge answers this one itself: it holds the pairs already
      case "where":
        if (recent.length === 0) { say("We have not started yet."); break; }
        for (const pair of recent) say(`You asked: ${pair.said} I said: ${firstSentence(pair.reply)}`);
        break;
      case "endTurn":
        if (!turnRunning) { say("Nothing is running."); break; }
        session.interrupt();
        say("Stopped.");
        break;
    }
  }

  async function dispatch(said: string): Promise<void> {
    const heard = match(said, config.wakeWord, muted, config.mutedCommands, config.wakeWordVariants);
    if (heard.kind === "command") { await run(heard.name); return; }
    // 9.7 the wake word came through and the command did not
    if (heard.kind === "unclear") { say("Say the command again."); return; }
    if (muted) return;
    // 10.2 the agreement word is a word said plainly, not a wake command
    if (checkpointOpen && said.toLowerCase().replace(/[^a-z ]/g, "").includes(config.agreementWord.toLowerCase())) {
      checkpointOpen = false;
      session.agree();
      say("Carrying on.");
      return;
    }
    if (turnRunning) return;
    // not awaited: the microphone has to stay open through the turn, or 9.4.8 and
    // the agreement word of 8.6.4 can never be heard, and the ceiling always wins
    void runTurn(said);
  }

  // 11.2 wants the microphone open while the bridge speaks. Until 7.4 brings the
  // echo cancellation of 4.2, the bridge would hear itself, so it listens
  // through the turn but not through its own voice, and drops any recording
  // that overlapped one.
  for (;;) {
    while (pending > 0) await Bun.sleep(50);
    // the speakers hold a little audio after the last sentence ends
    await Bun.sleep(config.listenSettleMs);
    if (pending > 0) continue;
    const before = speech;
    const wav = join(scratch, `heard-${++counter}.wav`);
    trace("listening");
    listening = recorder(wav, config);
    await listening.exited;
    listening = null;
    if (speech !== before || pending > 0) { trace("cut short: the bridge started to speak"); continue; }
    const said = await stt.transcribe(wav);
    if (!said) { trace("nothing in it"); continue; }
    console.log(`\n> ${said}`);
    trace(`turn=${turnRunning} checkpoint=${checkpointOpen} muted=${muted}`);
    await dispatch(said);
  }
}

function firstSentence(text: string): string {
  const at = text.search(/[.!?]\s/);
  return at < 0 ? text : text.slice(0, at + 1);
}

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();

if (command === "config") {
  showConfig(config);
} else if (command === "chat") {
  const dir = rest[0];
  if (!dir) { console.error("usage: bun src/main.ts chat <project-dir>"); process.exit(2); }
  await chat(dir, config);
} else if (command === "voice") {
  const dir = rest[0];
  if (!dir) { console.error("usage: bun src/main.ts voice <project-dir>"); process.exit(2); }
  await voice(dir, config);
} else {
  console.error("usage: bun src/main.ts <chat <project-dir> | voice <project-dir> | config>");
  process.exit(2);
}

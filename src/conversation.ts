/**
 * What the bridge does with a thing Chris said, whatever carried it.
 *
 * The desk loop of 7.3 and the LiveKit room of 7.4 differ only in how audio
 * arrives and how it leaves. Everything above that — the turn, the sentences,
 * the wake commands, the checkpoint, the memory of what was said — is the same,
 * so it lives here and each transport supplies the two ends.
 */
import { match, type CommandName } from "./commands.ts";
import type { Config } from "./config.ts";
import { SentenceCollector } from "./sentences.ts";
import { Session, type Turn } from "./session.ts";
import type { SpeechToText, TextToSpeech } from "./speech.ts";

export type CueName = "thinking" | "starting";

export interface Mouth {
  /** Speak one sentence. The bridge says nothing else until this returns. */
  say(text: string): Promise<void>;
  /** 15.2 a sound that is not speech, for a wait that has gone on. */
  cue(name: CueName): void;
  /** 4.3 the control channel: the transcript and the turn number (14.5, 14.7). */
  tell?(value: Record<string, unknown>): void;
}

export interface ConversationHooks {
  onNarration?(text: string): void;
  onTurn?(turn: Turn): void;
}

export class Conversation {
  private muted = false;
  private turnRunning = false;
  private checkpointOpen = false;
  private lastReply = "";
  private queue: Promise<void> = Promise.resolve();
  /** Bumped to abandon everything still queued to be said (11.3). */
  private epoch = 0;
  private speaking = false;
  /** 9.4.7 the last three request and reply pairs, which the bridge answers from itself */
  private readonly recent: Array<{ said: string; reply: string }> = [];
  /** 14.7 the light transcript, which 14.8 replays to a client that just arrived */
  private readonly transcript: Array<Record<string, unknown>> = [];

  readonly session: Session;

  constructor(
    dir: string,
    private readonly config: Config,
    private readonly mouth: Mouth,
    private readonly stt: SpeechToText,
    private readonly tts: TextToSpeech,
    hooks: ConversationHooks = {},
  ) {
    // 6.5 the voice instruction lives in the bridge, not in the agent's identity file
    const args = [...config.claudeArgs, "--append-system-prompt", config.voiceInstruction];
    this.session = new Session(dir, { ...config, claudeArgs: args }, {
      onDelta: (text) => this.deltaSink?.(text),
      onNarration: (text) => hooks.onNarration?.(text),
      // 8.6.3 speak, say how long it has run, and report the usage with the ask (8.6.4)
      onCheckpoint: (ms) => {
        this.checkpointOpen = true;
        this.speak(`This turn has run ${Math.round(ms / 60_000)} minutes and cost ${this.session.totalCostUsd().toFixed(2)} dollars. Say ${config.agreementWord} to let it run on.`);
      },
      onInterrupt: () => { this.checkpointOpen = false; },
      onRestart: () => this.mouth.cue("starting"),
    });
    this.onTurn = hooks.onTurn;
  }

  private onTurn?: (turn: Turn) => void;
  private deltaSink: ((text: string) => void) | null = null;

  get busy(): boolean { return this.turnRunning; }
  get waitingForAgreement(): boolean { return this.checkpointOpen; }
  get isMuted(): boolean { return this.muted; }

  /** Sentences never overlap, and they keep their order (5.7). */
  private speak(text: string): void {
    const epoch = this.epoch;
    this.queue = this.queue
      .then(async () => {
        if (epoch !== this.epoch) return;
        this.speaking = true;
        try { await this.mouth.say(text); } finally { this.speaking = false; }
      })
      .catch(() => { /* a transport that dropped is not this loop's problem */ });
  }

  /**
   * 11.3 stop the playback the moment Chris starts to talk — all of it. Cutting
   * only the sentence in flight lets the queue drain into the gap, so the
   * bridge keeps talking and stops each sentence in turn, which sounds worse
   * than not stopping at all.
   */
  stopSpeaking(): void {
    this.epoch += 1;
  }

  private async drained(): Promise<void> { await this.queue; }

  /** Say it on the control channel and keep it, so 14.8 can say it again. */
  private remember(value: Record<string, unknown>): void {
    this.transcript.push({ ...value, at: Date.now() });
    if (this.transcript.length > 40) this.transcript.shift();
    this.mouth.tell?.(value);
  }

  /**
   * 14.8 what a client missed while it was away — which is a drop in a tunnel,
   * measured in minutes. Replaying an exchange from hours ago is not that: it
   * arrives looking like the conversation in progress, and the reader has no
   * way to tell that they are being shown something they did not say.
   */
  missed(now = Date.now()): Array<Record<string, unknown>> {
    return this.transcript.filter((entry) => now - (entry.at as number) <= this.config.historyMaxAgeMs);
  }

  /** One thing Chris said. */
  async heard(said: string): Promise<void> {
    const heard = match(said, this.config.wakeWord, this.muted, this.config.mutedCommands, this.config.wakeWordVariants);
    this.remember({ kind: "heard", text: said });
    if (heard.kind === "command") { await this.run(heard.name); return; }
    // 9.7 the wake word came through and the command did not
    if (heard.kind === "unclear") { this.speak("Say the command again."); return; }
    if (this.muted) return;
    // 10.2 the agreement word is a word said plainly, not a wake command
    if (this.checkpointOpen && plain(said).includes(this.config.agreementWord.toLowerCase())) {
      this.checkpointOpen = false;
      this.session.agree();
      this.speak("Carrying on.");
      return;
    }
    // 15.1 a question that arrives mid-turn must not vanish into silence
    if (this.turnRunning) { this.speak(`I am still on the last one. Say ${this.config.wakeWord}, end the turn, to stop it.`); return; }
    void this.turn(said);
  }

  /** Not awaited by the caller: the microphone has to stay open through a turn. */
  async turn(said: string): Promise<void> {
    this.turnRunning = true;
    const sentences = new SentenceCollector(this.config.sentenceMaxChars);
    const spoken: string[] = [];
    this.deltaSink = (text) => {
      for (const sentence of sentences.push(text)) { spoken.push(sentence); this.speak(sentence); }
    };
    const stopCue = this.cueWhileWaiting();
    try {
      const turn = await this.session.ask(said);
      const tail = sentences.flush();
      if (tail) { spoken.push(tail); this.speak(tail); }
      await this.drained();
      this.lastReply = spoken.join(" ") || turn.text;
      this.recent.push({ said, reply: this.lastReply });
      if (this.recent.length > 3) this.recent.shift();
      this.remember({ kind: "turn", number: turn.number, text: this.lastReply, costUsd: this.session.totalCostUsd() });
      this.onTurn?.(turn);
      // 13.2 the warning uses the number claude reports, never an estimate (16.6)
      const worst = Math.max(this.session.rateLimit.fiveHour, this.session.rateLimit.sevenDay);
      if (worst >= this.config.usageWarnFraction) this.speak(`A heads up: rate limit use is at ${Math.round(worst * 100)} percent.`);
    } catch (error) {
      this.speak("That turn did not finish.");
      this.mouth.tell?.({ kind: "error", text: (error as Error).message });
    } finally {
      stopCue();
      this.deltaSink = null;
      this.turnRunning = false;
      this.checkpointOpen = false;
    }
  }

  /** 15.1 a wait must not be silence. 15.5 only once the wait is long enough. */
  private cueWhileWaiting(): () => void {
    let timer = setTimeout(function tick(this: Conversation) {
      // 15.1 a cue fills silence. Never over the voice — one transport shares a
      // single audio source and refuses two writers — and never while an answer
      // is wanted, because at the checkpoint the bridge has just asked for one.
      if (!this.checkpointOpen && !this.speaking) this.mouth.cue("thinking");
      timer = setTimeout(tick.bind(this), this.config.audioCueEveryMs);
    }.bind(this), this.config.audioCueDelayMs);
    return () => clearTimeout(timer);
  }

  /** 9.4 the commands. Each answers out loud, because silence is ambiguous (15.1). */
  private async run(name: CommandName): Promise<void> {
    switch (name) {
      case "mute": this.muted = true; this.speak("Muted."); break;
      case "unmute": this.muted = false; this.speak("Listening."); break;
      // 8.8 a fresh process is a fresh context
      case "clearContext": this.session.restart("cleared by voice"); this.speak("Context cleared."); break;
      case "usage": {
        const context = this.session.contextFraction();
        this.speak(`This session has cost ${this.session.totalCostUsd().toFixed(2)} dollars.`);
        const { fiveHour, sevenDay } = this.session.rateLimit;
        if (fiveHour || sevenDay) this.speak(`Rate limit use is ${Math.round(fiveHour * 100)} percent of the five hour window and ${Math.round(sevenDay * 100)} percent of the seven day window.`);
        if (context !== null) this.speak(`The context is ${Math.round(context * 100)} percent of the compaction threshold.`);
        break;
      }
      case "restate": this.speak(this.lastReply || "There is nothing to restate yet."); break;
      case "summarize":
        if (!this.lastReply) { this.speak("There is nothing to summarize yet."); break; }
        void this.turn("Summarize your last answer in one short spoken sentence.");
        break;
      case "where":
        if (this.recent.length === 0) { this.speak("We have not started yet."); break; }
        for (const pair of this.recent) this.speak(`You asked: ${pair.said} I said: ${firstSentence(pair.reply)}`);
        break;
      case "endTurn":
        if (!this.turnRunning) { this.speak("Nothing is running."); break; }
        this.session.interrupt();
        this.speak("Stopped.");
        break;
    }
  }

  /** One utterance of PCM becomes one thing Chris said. */
  async transcribe(wavPath: string): Promise<string> {
    return this.stt.transcribe(wavPath);
  }

  synthesize(text: string, wavPath: string): Promise<string> {
    return this.tts.synthesize(text, wavPath);
  }

  start(): void { this.session.start(); }
  stop(): void { this.session.stop(); }
}

function plain(text: string): string {
  return text.toLowerCase().replace(/[^a-z ]/g, "");
}

function firstSentence(text: string): string {
  const at = text.search(/[.!?]\s/);
  return at < 0 ? text : text.slice(0, at + 1);
}

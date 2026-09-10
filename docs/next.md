# Where this is, and what the next process should know

Last touched 9 September 2026. Read this before `docs/voice-bridge-spec.md`;
the spec says what the product is, this says how far it got and what is not
true yet.

## State

Build order is spec section 7.

| Step | State |
|---|---|
| 7.1 narration hook | removed from the spec. The bridge narrates instead |
| 7.2 text round trip | done, on `main` |
| 7.3 voice | done |
| 7.4 web client | done, over the tailnet, on a trusted certificate |
| 7.5 Android app | not started |

7.2 and 7.3 are on `main`; 7.4 is on `feature/web-client`. The project bridge that used to be
in this repository is on `project-bridge` and still runs the story pipeline.

## Corrections to the previous revision of this file

Three claims in the last revision were wrong. Each was checked on 9 September
2026 against claude 2.1.267 on the WSL2 machine.

1. **7.1 was never done, and is now removed.** The last revision said the
   narration hook was in aleph at `hooks/narrate.ts`. No such file exists, on
   any branch of aleph, in any commit; nothing under `~/aleph` or `~/.aleph`
   contains the word "narration". The step is now deleted from the spec rather
   than built. See below.
2. **The context percentage does not come back.** A real turn returns the reply
   and the cost. It does not return the context, because claude 2.1.267 emitted
   no `autocompact_state` event in any run here. The string is in the binary,
   so the event exists; the condition that emits it was not met by a short
   session in a small directory. `contextFraction()` returns null and the chat
   prints no percentage, which is the intended degrade (8.9), not a bug.
3. **The GPU is 12 GB, not 8.** `nvidia-smi` reports one RTX 5070 with
   12227 MiB. Spec 4.7 states eight gigabytes as a fact about the machine, and
   4.10 budgets the voice path at "eight gigabytes, the whole GPU"; both numbers
   are low. The models of 4.6 and 4.9 can be larger than the spec assumed.

   Two things temper it. About 2113 MiB is already in use with nothing running,
   so the free figure is nearer 10 GB than 12. That also qualifies 4.11, which
   says the machine does no other GPU work: the Windows desktop does some. The
   budget setting stays at eight until a model needs more, because eight fits
   inside the free figure with room to spare and nothing yet asks for it.

## What is now verified

All three items the last revision listed as unverified were checked against a
real process. Two passed as written. One was broken.

- **The interrupt message shape is right.** `{"type":"control_request",
  "request":{"subtype":"interrupt"}}`, with no `request_id`, is accepted. The
  receipt comes back in about 10 ms as `{"type":"control_response","response":
  {"subtype":"success","response":{"still_queued":[]}}}`, the turn ends with
  `subtype:"error_during_execution"` and `terminal_reason:"aborted_streaming"`,
  and the process stays alive. The init event advertises
  `interrupt_receipt_v1`, `interrupt_cancel_queued_v1` and `msg_lifecycle_v1`.
- **The ceiling ladder runs end to end.** With the times shortened, a real turn
  reached the checkpoint at the ceiling, took the interrupt when no agreement
  came, ended with `isError`, and left the process alive — stage three never
  ran, because the process was ready inside the grace. With the agreement word
  the same turn extended four times and finished normally, which is 8.6.4.
- **The restart path was broken, and is fixed.** `restart()` spawned a new
  process while the old `pump()` loop was still draining the stream of the one
  it killed. That stale loop then rejected the *first turn of the new process*
  with "the Claude Code process ended mid-turn" — so every restart, from any of
  the four causes, poisoned the turn after it. The loop now checks that the
  child it reads is still the current one. A restart followed by a turn is now
  a run that happened: new pid, correct answer.

## 7.1 is removed, and why

Spec 2.3 and 7.1 put the narration in an aleph hook, because a plugin can see
which tool is about to run and the bridge was assumed not to. On claude 2.1.267
that assumption is false. The parent stream carries every tool call the bridge
needs, subagent calls included:

```
6.0s  tool_use Agent  id=toolu_012S...  parent=null
8.3s  tool_use Bash   id=toolu_01WC...  parent=toolu_012S...
13.9s tool_result     for=toolu_012S... parent=null
```

`parent_tool_use_id` names the Agent call an inner tool runs inside, so the
stream never goes quiet inside a subagent. A hook writing
`~/.aleph/narration/<session>.jsonl` for the bridge to tail would add a writer,
a file and a tailer to deliver less than stdout already gives, and it would put
a voice decision in aleph, against 3.4 and 6.5.

So the narration is `src/narrator.ts` in the bridge. A tool call that outlives
`narrationDelayMs` gets one phrase; a call inside a subagent says so; a quick
call says nothing, which is 15.5. At 7.3 the phrases are spoken instead of
printed.

Chris removed the step on 9 September 2026. Spec 2.3 and 7.1 now say so, and
the step numbers stay as they are because other sections point to them.

The hook had one argument left: it would also narrate an interactive session,
which the bridge cannot reach. That argument does not hold. A terminal session
already shows each tool call on the screen, so it has no silence to fill, and
aleph already instruments PreToolUse in `hooks/obs.ts`, which records the tool
name and input to Langfuse. Nothing was left for a narration hook to do.

Two limits worth knowing:

- The narration is evaluated on the same one-second tick as the ladder, so a
  tool call shorter than a tick is never narrated whatever the delay says. This
  is wanted — a 100 ms read is noise in a spoken conversation — but it means a
  `narrationDelayMs` below about a second buys nothing.
- Narration continues after the turn ends, when a subagent is still working in
  the background. That is 2.3 doing its job, not a leak.

## Two things were built but not wired. One still is not.

- **The memory recycle (8.7) now has a source.** The session samples
  `/proc/<pid>/status` VmRSS on the same one-second tick that drives the
  ladder. With the limit set below the real footprint the recycle fires between
  turns and never mid-answer, as 8.7.3 requires. A healthy claude 2.1.267 sits
  at about 290 MB, so the 4 GB default is about fourteen times a healthy
  footprint — the spec guessed eight to ten. This is most of measurement 18.7;
  what is left is watching it over a long session rather than a short one.
- **The narration needs no file at all.** See the section above. What the last
  revision called "the narration file has no reader" is answered by deleting the
  file from the design, not by writing a tailer.

## What 7.3 needs that is now in place

The reply streams. `--include-partial-messages` sends the reply as
`stream_event` frames carrying `content_block_delta` / `text_delta`, and the
parser turns those into `delta` events that reach `SessionHooks.onDelta`. This
is 5.5. The sentence collector of 5.6 hangs off that hook.

Watch one trap: with partial messages on, the reply arrives twice — once as
deltas, then whole in the `assistant` message that follows. Only the whole
message becomes a `text` event and accumulates into the reply, so the two do
not add up. Anything new that reads `delta` must not also read `text`.

## 7.3, what works and what does not

Everything in the voice path is local, and no part of it reaches a network.
Speech to text is faster-whisper with `small.en` on the GPU; text to speech is
piper with `en_US-lessac-medium` on the CPU. Both run as long-lived workers
under `speech/`, warmed at startup.

Verified by driving the real loop with real audio, by making the bridge's own
speaker its microphone:

| | |
|---|---|
| a spoken question, answered aloud | yes |
| 6.6, a question about code | came back summarized, no path, no code, no markdown |
| 9.4, the commands | mute, unmute, usage, restate, where, all by voice |
| 9.5, muted | the next question was heard and ignored |
| 8.6.3 and 8.6.4 | the checkpoint spoke the elapsed time and the cost, "continue" extended the turn, and the ladder asked again |
| 9.4.8 | "hey bridge, end the turn" stopped a running tool call |
| 2.3 | the narration says what a long tool call is doing |

Measured on an RTX 5070 and claude 2.1.267:

| | |
|---|---|
| engines warm | 1.2 to 2.0 seconds, once, at startup |
| whisper | 0.20 s for 5.56 s of audio, 27 times real time, about 657 MiB |
| whisper, first call on a cold GPU | 7.4 seconds, which is why the warmup exists |
| piper | about 0.1 second a sentence, 20 times real time |
| time to first audio | 2.3 to 2.7 seconds |

**Barge-in is not in the desk loop and never will be.** Without echo
cancellation the bridge transcribes its own voice, so every sound it makes stops
the microphone. Over LiveKit at 7.4 the client cancels the echo and barge-in
works. The desk loop stays as the local fallback.

## 7.4, and the one thing that stands between it and a phone

`bun src/main.ts serve <dir>` puts the bridge in a LiveKit room, serves the
client page and prints a three-word pairing code. Verified against a real
livekit-server with a headless stand-in for the phone:

| | |
|---|---|
| 12.2, 12.4 | pairs once with the code, keeps a long-lived token, the secret stays on the machine |
| 5.1 to 5.9 | the stand-in speaks a question and gets spoken audio back |
| 4.3, 14.5, 14.7 | the transcript and the turn number arrive on the data channel, not on the audio path |
| 11.1 to 11.3 | barge-in: the bridge stops 6 ms after it notices, and abandons the rest of the answer |
| 14.8 | a client that leaves and comes back is given the turns it missed |

**The page works in a real browser.** Playwright drives it with a wav file for a
microphone, so there is no human and no phone in the loop:
`scripts/browser-check.ts`. It pairs, stores the token, connects, publishes the
microphone, is heard, and renders the answer, with no console error. At iPhone
width there is no horizontal overflow. What is still unproven is a real phone
microphone in a real car, which is 18.6 and needs hardware.

**A page that is not https gets no microphone at all.** This is the finding that
matters, and every earlier test hid it. Browsers treat loopback as a secure
context and nothing else, so `http://127.0.0.1:3100` works and
`http://172.23.44.63:3100` does not: `navigator.mediaDevices` is not defined,
the page still loads, the room still connects, and no audio is ever published.
Measured:

| origin | secure context | getUserMedia |
|---|---|---|
| `http://127.0.0.1:3100` | true | granted |
| `http://172.23.44.63:3100` | **false** | `navigator.mediaDevices` is undefined |
| `https://172.23.44.63:3100` | true | granted, 1 track |

Two more follow from it. An https page may not open a `ws://` socket, so
LiveKit's signalling needs a TLS terminator in front of it. And LiveKit
advertises the address it believes it has, which inside WSL2 is one no phone can
route to, so the media silently never arrives even when signalling is fine.

All three are now settled in code and proved together on a non-loopback address:
the page over https, the signalling over wss through a terminator, the media
direct over UDP, and the whole browser run passes — microphone granted, question
heard, answer rendered, no console error.

**The tailnet is up and the whole thing runs over it.** This machine is
`lightbox2.tail15c879.ts.net` at `100.68.96.43`. `advertiseHost` finds that
address by itself and LiveKit advertises it, the page is served over https on
3100, the signalling is terminated on 8443, and the media goes straight over the
tailnet. A browser at phone width pairs, is heard, and renders the answer, with
no console error.

**The certificate is a real one.** The tailnet has HTTPS certificates turned on,
`bun src/main.ts cert` fetched a Let's Encrypt certificate for
`lightbox2.tail15c879.ts.net`, and the whole run passes with no certificate
exception anywhere: the browser check is strict by default now, and `INSECURE=1`
is the opt-out for a self-signed pair. That matters because a phone makes no
allowance either — it refuses the microphone over a certificate it does not
trust, and that lands as the same silent no-`mediaDevices` failure as plain
http.

Two operational things, neither of them code that is missing:

- **The certificate expires on 9 December 2026.** `tailscale cert` renews it,
  but only when something runs it. Nothing does. Re-run `bun src/main.ts cert`,
  or teach `serve` to refresh at startup.
- **Nothing survives a reboot.** `livekit` and the TLS terminator in front of it
  are containers started by hand, and the bridge is a foreground process. The
  machine deploys with systemd units; these should be three of them.

**What is genuinely untried is a phone.** Every run has been a browser on this
machine with a wav file for a microphone. 18.4 and 18.6 — the time to first
audio measured from the phone, and what a phone microphone does in a moving car
— need hardware and a drive.

**The keys are no longer `devkey`.** `bun src/main.ts livekit` makes a pair, keeps
it in `~/.voice-bridge/keys.json` at mode 600, and writes the matching server
config, so the two cannot drift apart.

Three faults the transport produced, each worth the comment it now carries:

1. **AudioFrame ignores a view's offset.** Handing it a subarray sends the start
   of the sentence again for every frame. A piper file opens quietly, so the
   fault arrives as silence rather than as a stutter, which is far harder to
   find. Copy each frame.
2. **A track subscribed before the handler attaches never fires again.** The
   bridge is then deaf for the life of the room, with audio visibly flowing.
   Walk the existing publications when registering.
3. **Stopping one sentence is not barge-in.** The queue drains into the gap, so
   the bridge keeps talking and stops each sentence in turn, which sounds worse
   than not stopping at all. The whole queue has to be abandoned.

Also: sox writes 32-bit float by default, which plays locally and is refused by
the wav reader that feeds the transport; and a cue must not play while the
bridge speaks, because one transport shares one audio source and it refuses two
writers.

## What the voice path taught

Four things that only appear when real audio goes through:

1. **Whisper writes words for silence.** A recording of room noise came back as
   "you" and the bridge sent it to the agent and paid for a turn. `vad_filter`
   fixes it: silence now transcribes as nothing.
2. **A recording must be cut, not discarded.** The first attempt let a recording
   run through the bridge's own speech and threw the whole thing away as
   self-heard. The checkpoint therefore asked for the agreement word and could
   never hear the answer, because the answer was inside the discarded recording.
   The microphone now stops the moment the bridge speaks and reopens after.
3. **A cue must not take the microphone.** When it did, a cue every seven
   seconds shredded every listening window. A cue is a tone: the voice detector
   drops it and nothing can transcribe it as words, so it is allowed to sit
   inside a recording. Only the voice has to cut one.
4. **"hey bridge" does not survive the engine.** `small.en` writes it as
   "Cambridge" about half the time, and sometimes drops the "hey" and leaves
   "bridge". 9.3 says the bridge accepts the forms the engine produces, so
   "cambridge" is now one, and the form list is a setting. Bare "bridge" is
   deliberately not accepted: Chris says "the bridge" constantly about this
   project. 18.8 says to settle the wake word by use, and the honest reading of
   this evidence is that "hey bridge" is a poor choice of wake word.

## Open decisions

Section 19 is closed except for one thing that moved into 2.8.2:

**A project cannot adjust the voice instruction.** 6.6 tells the agent to
summarize instead of reading things out. The story pipeline needs the opposite
for one case — read the five candidates in full, premise then vignette, no
summarising — and 6.1 says a project declares nothing, so there is no way for
it to say so. This needs a seam, and it is a design decision, not code. It
blocks the pipeline moving to the general bridge (2.8), not 7.3.

## Before trusting any of it on another machine

The context reading depends on Claude Code emitting `autocompact_state`. It did
not emit one here (see correction 2), and none of it is a promised interface.
`--output-format stream-json` is still refused without `--verbose` (16.7).

## Settings

Section 21 of the spec now holds every setting, including the three that said
"to set at" and got their first values at 7.3: the end-of-turn pause, the usage
warning level and the audio cue delay.

## Measurements

Section 18, none blocking. 18.7 is partly done: a healthy footprint is about
290 MB. The rest need real hardware and a long session.

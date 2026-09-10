# voice-bridge

Drive a Claude Code session by voice, from a phone, over a bridge that runs on
your own machine. Claude Code does the reasoning; the bridge owns every voice
decision and does speech locally.

The full specification is [`docs/voice-bridge-spec.md`](docs/voice-bridge-spec.md).
Section numbers in the source refer to it. Picking this up after a break:
[`docs/next.md`](docs/next.md) says how far it got, and which parts look
finished but are not verified.

> The manifest-to-MCP **project bridge** that used to live here is on the
> `project-bridge` branch. It still runs the story pipeline; nothing about it
> changed. `git checkout project-bridge` to get it back.

## Where it is

Build order is spec section 7. Done so far:

| | |
|---|---|
| 7.1 narration hook | removed from the spec; the bridge narrates from the stream |
| 7.2 text round trip | **here**, `bun src/main.ts chat <dir>` |
| 7.3 voice | **here**, `bun src/main.ts voice <dir>` |
| 7.4 web client | **here**, `bun src/main.ts serve <dir>` |
| 7.5 Android app | not started |

```bash
bun install
bun src/main.ts chat ~/some-project    # a spoken conversation, typed
bun src/main.ts voice ~/some-project   # a spoken conversation, at the desk
bun src/main.ts serve ~/some-project   # the same, for a phone, over LiveKit
bun src/main.ts config                 # every setting, and which are not default
```

Voice needs the two local engines once:

```bash
uv venv .venv
uv pip install --python .venv/bin/python faster-whisper piper-tts nvidia-cublas-cu12 nvidia-cudnn-cu12
.venv/bin/python -m piper.download_voices --download-dir ~/.voice-bridge/models en_US-lessac-medium
```

The text loop is useful on its own, and it is where the process management gets
exercised before any audio exists. The reply streams word by word, through the
same hook that will feed the sentence collector when voice arrives.

## Layout

| | |
|---|---|
| `src/config.ts` | section 21 entire: every default in the spec, as a setting |
| `src/protocol.ts` | Claude Code's stream-json output, reduced to what the bridge acts on |
| `src/supervisor.ts` | the three fault detectors of section 8, as a clock-driven state machine |
| `src/narrator.ts` | what the bridge says while a tool runs, so a long turn is not silence |
| `src/speech.ts` | section 4: the two local engines, each behind the interface of 4.8 |
| `src/sentences.ts` | section 5.6: the streamed reply cut at sentence ends |
| `src/commands.ts` | section 9: the wake word, matched by sound rather than spelling |
| `src/cues.ts` | section 15: a soft tone, so a wait is never plain silence |
| `src/conversation.ts` | the turn, the commands and the checkpoint, above any transport |
| `src/transport.ts` | section 4.1: LiveKit over WebRTC, and the control channel of 4.3 |
| `src/audio.ts` | the ends of a turn, found in frames rather than by sox |
| `src/serve.ts` | section 7.4 and 12: the room, the client page and the pairing |
| `client/index.html` | the phone client. Keep the screen on (2.4) |
| `speech/*.py` | the two engines as long-lived workers, warmed at startup |
| `src/session.ts` | one long-lived Claude Code process, text in and text out |
| `src/main.ts` | the text loop |

## Process management

A warm agent process is the thing most likely to break, so section 8 gives it
three detectors that fail in different ways:

- **Silence** (8.4). No output on any channel for a minute and the process is
  dead. A tool call that is still running counts as activity, because a command
  that takes minutes emits nothing while it runs and would otherwise look
  exactly like a corpse.
- **Compaction loop** (8.5). More than three compactions in five minutes is a
  process that is busy but stuck, and the silence timer would never fire on it.
- **Ceiling** (8.6). Ten minutes into one turn the bridge speaks, says how long
  it has run and asks for the agreement word. Without one it interrupts the
  turn and keeps the process, its context and the conversation. It restarts
  only if the process does not come back within the grace time — the failed
  interrupt is the evidence that a restart is warranted.

Silence is checked before the ceiling: a dead process cannot answer a
checkpoint, so asking one would only delay its restart by the window and the
grace.

A fourth guard is not a fault detector. The **memory recycle** (8.7) samples the
resident size of the process on the same tick and recycles it past four
gigabytes, always between turns, never mid-answer. A healthy claude sits near
290 MB.

## Voice

Everything in the voice path is local, and 4.5 makes that a constraint rather
than a default: there is no cloud engine behind the interface of 4.8 and no
fallback to one. Speech to text is faster-whisper with `small.en` on the GPU,
about 657 MiB and 27 times real time. Text to speech is piper on the CPU, about
a tenth of a second a sentence. Both run as long-lived workers, because both
cost seconds to load and the bridge pays that at startup instead of on the
first thing you say.

The reply is cut at sentence ends and spoken sentence by sentence while the
model still writes the rest, so the time to first audio is the time to the
first sentence — 2.3 to 2.7 seconds measured at the desk.

Say "hey bridge" and then a command: mute, unmute, clear the context, report
the usage, say that again, summarize, report where we are, end the turn. The
wake word is matched by sound, not spelling, because an engine writes the same
sound several ways.

At the desk there is no barge-in: without echo cancellation the bridge would
transcribe its own voice, so every sound it makes stops the microphone. Over
LiveKit the client cancels the echo and barge-in works — the bridge stops about
six milliseconds after it notices Chris talking, and abandons the rest of what
it was going to say.

## The phone

```bash
docker run -d --network host livekit/livekit-server --dev --bind 0.0.0.0
bun src/main.ts serve ~/some-project
```

The bridge prints a three-word pairing code. The phone opens the page, gives the
code once, and keeps a long-lived token from then on. The api secret never
leaves the machine.

The page keeps a light transcript, which is also the audit trail (14.7), and a
client that drops in a tunnel is given the turns it missed when it comes back
(14.8). Keep the screen on: a web page cannot hold the microphone open behind a
lock screen, which is the whole reason for the Android app at 7.5.

`bun test` cannot reach the page, so two scripts do what a unit test cannot.

`scripts/browser-check.ts` drives the real page in a real browser, with a wav
file for a microphone. `PHONE=1` runs it at phone width, and `INSECURE=1` is the
only way to get past a certificate the browser does not trust.

`scripts/fake-phone.ts` is a phone without the phone: it pairs, joins, speaks
with the same local voice the bridge uses, and transcribes what the bridge says
back, so a spoken conversation can be scripted and read.

```bash
bun scripts/fake-phone.ts "what is two plus two" "say the word done"
bun scripts/fake-phone.ts --dir ~/some-project "summarise the readme"
bun scripts/fake-phone.ts --barge 6000 "list twenty primes" "stop, different question"
bun scripts/fake-phone.ts "run something slow" "+30s:continue"
```

A line may say when it is spoken. Some things only happen on a clock — the
checkpoint of 8.6.3 is one — and a script that waits for the bridge to finish
arrives before them and is answered as ordinary speech.

It starts a bridge of its own, on a free port and in a room of its own, and
stops it at the end. That is not tidiness: there is one long-lived room in
normal use, and a test client that joins it turns up in the real conversation,
on the real phone.

### Reaching it from the phone

Three things have to be true, and each one fails quietly on its own.

**The page must be https.** A browser gives no microphone to a page that is not
a secure context, and only loopback is exempt. Over plain http from any other
address `navigator.mediaDevices` is simply not there: the page loads, the room
connects, and no audio is ever published. Everything that works on the desktop
works because `127.0.0.1` is special-cased.

**The socket must be wss.** An https page may not open a `ws://` socket, and
LiveKit speaks plain ws, so something has to terminate TLS in front of it.

**LiveKit must advertise an address the phone can route to.** It advertises the
one it believes it has, which inside WSL2 is a WSL address. Signalling then
connects and the media silently never arrives.

`bun src/main.ts livekit` writes a server config that settles the third, with
keys of its own rather than the `devkey` pair every example uses:

```bash
bun src/main.ts livekit          # writes ~/.voice-bridge/livekit.yaml
docker run -d --name livekit --network host \
  -v ~/.voice-bridge/livekit.yaml:/livekit.yaml \
  livekit/livekit-server --config /livekit.yaml
```

#### Over Tailscale

Tailscale settles all three, and it is the only option that also works away from
the house, which is what 14.1 is about. It carries UDP, so the media path stays
direct rather than falling back to TCP, and `advertiseHost` finds the tailnet
address by itself.

The tailnet has to have HTTPS certificates turned on, at
<https://login.tailscale.com/admin/dns>. Then:

```bash
bun src/main.ts cert       # a real certificate, into ~/.voice-bridge
bun src/main.ts livekit    # the server config, advertising the tailnet address
docker run -d --name livekit --network host \
  -v ~/.voice-bridge/livekit.yaml:/livekit.yaml \
  livekit/livekit-server --config /livekit.yaml
```

LiveKit speaks plain ws, so put a terminator in front of it on 8443 with the
same certificate — any reverse proxy does; `caddy` is two lines. Then
`~/.voice-bridge/config.json`:

```json
{
  "publicOrigin": "https://<machine>.<tailnet>.ts.net:3100",
  "livekitPublicUrl": "wss://<machine>.<tailnet>.ts.net:8443",
  "tlsCert": "/home/you/.voice-bridge/tls-cert.pem",
  "tlsKey": "/home/you/.voice-bridge/tls-key.pem"
}
```

Keep the pairing code. A tailnet is a good boundary, and 12.1 still says the
endpoint is the boundary.

#### Without Tailscale

The same three settings, with a certificate from anywhere the phone trusts. A
self-signed pair proves the shape — it is how the https path above was first
tested — but a phone refuses the microphone over a certificate it does not
trust, so it is not a place to stop.

## Settings

No file is needed. To change one, write `~/.voice-bridge/config.json`
(`$VOICE_BRIDGE_CONFIG` overrides) with just the fields you want:

```json
{ "model": "opus", "ceilingMs": 900000 }
```

`bun src/main.ts config` prints the effective values and marks the ones you
have set. A timer that is not a positive number, or an agreement word of
"yes", is refused rather than quietly replaced — 10.3 exists so a reflex or a
bad transcription cannot agree to something.

## Tests

```bash
bun test        # the parser against captured claude output, and the ladder against a fake clock
bun run typecheck
```

The supervisor takes a clock, so the whole escalation is tested without
spawning anything. What a clock cannot show — that the interrupt shape is
right, that a restarted process answers, that the ladder ends a real turn — was
checked by hand against claude 2.1.267. `docs/next.md` says what was seen.

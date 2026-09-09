# voice-bridge

Drive a Claude Code session by voice, from a phone, over a bridge that runs on
your own machine. Claude Code does the reasoning; the bridge owns every voice
decision and does speech locally.

The full specification is [`docs/voice-bridge-spec.md`](docs/voice-bridge-spec.md).
Section numbers in the source refer to it.

> The manifest-to-MCP **project bridge** that used to live here is on the
> `project-bridge` branch. It still runs the story pipeline; nothing about it
> changed. `git checkout project-bridge` to get it back.

## Where it is

Build order is spec section 7. Done so far:

| | |
|---|---|
| 7.1 narration hook | in [aleph](https://github.com/crsmithdev/aleph), `hooks/narrate.ts` |
| 7.2 text round trip | **here**, `bun src/main.ts chat <dir>` |
| 7.3 voice | not started |
| 7.4 web client | not started |
| 7.5 Android app | not started |

```bash
bun install
bun src/main.ts chat ~/some-project    # a spoken conversation, typed
bun src/main.ts config                 # every setting, and which are not default
```

The text loop is useful on its own, and it is where the process management gets
exercised before any audio exists.

## Layout

| | |
|---|---|
| `src/config.ts` | section 21 entire: every default in the spec, as a setting |
| `src/protocol.ts` | Claude Code's stream-json output, reduced to what the bridge acts on |
| `src/supervisor.ts` | the three fault detectors of section 8, as a clock-driven state machine |
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
spawning anything.

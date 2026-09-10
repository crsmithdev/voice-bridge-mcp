# Where this is, and what the next process should know

Last touched 9 September 2026. Read this before `docs/voice-bridge-spec.md`;
the spec says what the product is, this says how far it got and what is not
true yet.

## State

Build order is spec section 7.

| Step | State |
|---|---|
| 7.1 narration hook | removed from the spec. The bridge narrates instead |
| 7.2 text round trip | done here, branch `voice-bridge` |
| 7.3 voice | not started — this is next |
| 7.4 web client | not started |
| 7.5 Android app | not started |

Not merged to `main`. The project bridge that used to be in this repository is
on `project-bridge` and still runs the story pipeline.

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

## Settings added

`narrationDelayMs`, default 5 seconds: how long a tool call must run before the
bridge says what it is. 21.4 says a value a builder wants to change during a
test is a setting, so it is one. It is not in the spec's section 21 table.

## Measurements

Section 18, none blocking. 18.7 is partly done: a healthy footprint is about
290 MB. The rest need real hardware and a long session.

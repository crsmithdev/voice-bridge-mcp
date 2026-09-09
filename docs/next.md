# Where this is, and what the next process should know

Last touched 9 September 2026. Read this before `docs/voice-bridge-spec.md`;
the spec says what the product is, this says how far it got and what is not
true yet.

## State

Build order is spec section 7.

| Step | State |
|---|---|
| 7.1 narration hook | done, in [aleph](https://github.com/crsmithdev/aleph) `hooks/narrate.ts`, branch `claude/voice-bridge-spec-doc-gxyfwt` |
| 7.2 text round trip | done here, branch `claude/voice-bridge-spec-doc-gxyfwt` |
| 7.3 voice | not started — this is next |
| 7.4 web client | not started |
| 7.5 Android app | not started |

Neither branch is merged to `main`. The project bridge that used to be in this
repository is on `project-bridge` and still runs the story pipeline.

## What is actually verified, and what only looks finished

Verified against claude 2.1.267 in a Linux container:

- The text round trip. A turn goes in, the reply, the cost and the context
  percentage come back. This is the only end-to-end evidence there is.
- `src/protocol.ts` against captured output, `src/supervisor.ts` against a fake
  clock, `src/config.ts` against files. 30 tests.

**Not verified. Do not assume these work:**

1. **The interrupt message shape.** `Session.interrupt` writes
   `{"type":"control_request","request":{"subtype":"interrupt"}}`. The init
   event advertises an `interrupt_receipt_v1` capability, but this exact shape
   was never sent to a running process and no receipt was ever read. If it is
   wrong, stage two of the ceiling ladder (8.6.5) silently does nothing and
   every ceiling ends in a restart 30 seconds later — the failure looks like a
   working ladder, which is why it is first on this list.
2. **The restart path.** `Session.restart` kills and respawns. It has never run
   against a real process, and nothing checks that the new process comes up.
3. **The ceiling ladder end to end.** Exercised only against a fake clock. No
   real turn has ever run for ten minutes.

## Two things are built but not wired

- **The memory recycle (8.7) has no source.** `Supervisor.memorySample` exists
  and is tested, and nothing ever calls it. Until something samples the
  process RSS on a timer, the leak guard is dead code. This is the smallest
  real task in the repository.
- **The narration file has no reader.** 7.1 writes
  `~/.aleph/narration/<session>.jsonl` and 7.2 does not read it. The bridge
  should tail it, and 8.4.5 means the lines also serve as activity. Wiring
  these two together is most of what makes a long turn tolerable, and it needs
  no audio, so it can be done before 7.3.

## Open decisions

Section 19 is closed except for one thing that moved into 2.8.2:

**A project cannot adjust the voice instruction.** 6.6 tells the agent to
summarize instead of reading things out. The story pipeline needs the opposite
for one case — read the five candidates in full, premise then vignette, no
summarising — and 6.1 says a project declares nothing, so there is no way for
it to say so. This needs a seam, and it is a design decision, not code. It
blocks the pipeline moving to the general bridge (2.8), not 7.3.

## Before trusting any of it on another machine

The context reading depends on Claude Code emitting `autocompact_state` and
`rate_limit_event`. Spec 16.2 asserted the opposite until this build
disproved it, and none of it is a promised interface. If the context
percentage comes back blank after an upgrade, that is why. The code degrades
to reporting nothing rather than to reporting something wrong.

Also: `--output-format stream-json` is refused without `--verbose` (16.7).

## Measurements

Section 18, none blocking. They all need real hardware and cannot be done in a
container. The cheapest one to start is 18.7: leave `bun src/main.ts chat` open
on a real project and watch the process RSS against the 4 GB recycle limit —
which is also how you would find out whether item 1 under "not wired" matters.

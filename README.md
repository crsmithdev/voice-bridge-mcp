# voice-bridge-mcp

A command-line tool, exposed to a claude.ai chat as a connector, so a voice
conversation can drive it. Each project declares its tools in an `mcp.toml`;
the bridge runs exactly those commands and returns what they print.

```
bun install
bun src/main.ts token                       # a token for projects.toml
bun src/main.ts check ~/some-project        # validate its mcp.toml
bun src/main.ts serve --port 3000           # http://127.0.0.1:3000/<project>/mcp/<token>
```

`~/.voice-bridge-mcp/projects.toml` names the projects:

```toml
[fogbelt]
dir = "~/fogbelt"
token = "…"                # from `token`; the path segment is the only auth
# env = { FOO = "bar" }    # added to the environment of every command
```

Put the bridge behind HTTPS (ngrok, Tailscale Funnel) and add
`https://<host>/<project>/mcp/<token>` as a custom connector with no
authentication.

## mcp.toml

```toml
description = "instructions the model reads before using the tools"

[tools.status]
description = "what the tool does"
command = ["./fogbelt", "status"]   # argv, run in the project directory
timeout = 120                       # seconds, immediate tools only

[tools.draw]
description = "start a draw"
command = ["./fogbelt", "draw"]
background = true                   # returns a job id at once

[tools.draw.args.genre]             # a flag or a positional
description = "horror or scifi"
enum = ["horror", "scifi"]
flag = "--genre"                    # `--genre horror`; a true boolean emits the bare flag

[tools.gate.args.draw]
position = 1                        # the nth positional after the command
required = true
[tools.gate.args.targets]
position = 3
variadic = true                     # a list, the last positional
[tools.gate.args.verb]
position = 2
fixed = "choose"                    # always emitted, never shown to the model
```

Argument `type` is `string` (default), `number`, or `boolean`. Every project
also gets `job <id>` and `jobs`; background jobs persist under
`~/.voice-bridge-mcp/jobs/<project>/` and survive a restart of the bridge.
Output over 40,000 characters is cut from the head.

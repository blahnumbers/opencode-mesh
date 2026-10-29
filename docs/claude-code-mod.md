# Claude Code mod (same-session peer)

Make an interactive Claude Code session a mesh peer **without a second
process**: the mod polls the mesh inbox and injects each message into the
session you are already using. This is the Claude Code equivalent of mesh
delivery in OpenCode, where the agent loop and the client share one session.

Use this when you want to talk to the guardian and receive mesh messages in
the same conversation. Use the [headless bridge](claude-code-bridge.md) when
nobody is attached (cron, CI, long unattended reviews).

## Requirements

- Claude Code **2.1.287 or later** (mods).
- A trusted workspace (Claude Code asks once per project).
- The mesh CLI built or installed (`bin/cli.js`).

## Load it

```bash
MESH_CLAUDE_PEER=claude-guardian \
MESH_CLI=/path/to/opencode-mesh/bin/cli.js \
claude --plugin-dir /path/to/opencode-mesh/claude-plugin
```

Resume an existing conversation in place — no fork:

```bash
MESH_CLAUDE_PEER=claude-guardian \
MESH_CLI=/path/to/opencode-mesh/bin/cli.js \
claude --resume 5329c8d9-b551-4167-836f-d80d98af7750 \
  --plugin-dir /path/to/opencode-mesh/claude-plugin
```

A dim line at session start reads `mesh: peer=claude-guardian cli=…`. If it
does not appear, the mod did not load (check `/plugin`, workspace trust, and
`claude plugin validate ./claude-plugin`).

If the plugin is loaded directly from this repository, `MESH_CLI` is optional:
the mod falls back to `../bin/cli.js` beside the plugin directory. Set it when
the plugin lives anywhere else.

## What it does

- Registers the peer on start with `transport: external`, agent `claude`.
- Every 2 seconds: `opencode-mesh inbox --peer <id> --claim --wake --owner <id>-mod`.
- Injects the claimed message with `$.prompt.submit({ text, asUser: true })`,
  which starts a turn in the same session and waits until it is idle.
- Acks the row after the turn starts; releases it on a refusal or error.
- Silent rows are **not** claimed by the poller. They stay pending for the
  `mesh_inbox` tool, so a deposit never starts a turn.
- Registers three tools:
  - `mesh_send({ target, text, silent? })`
  - `mesh_peers()`
  - `mesh_inbox()` (peek, including silent rows)

The injected text keeps the wire header:

```
[OC-MESH | SENDER: build - ses_abc…]

…body…

---
(mesh) Reply to this sender with the mesh_send tool: target "ses_abc…".
```

## Caveats

- **Interrupts**: after Esc, `$.prompt.submit` is refused until your next
  input. The mod keeps the row and retries after 30 seconds (or sooner when
  you type).
- **One peer per session**: the poller is bound to `MESH_CLAUDE_PEER`. Run one
  guardian session per peer id.
- **Session must be open**: the timer lives in the Claude Code process. This is
  the point — but it means no delivery while Claude Code is closed.
- **Mods can be restricted** by managed settings (`disableAllHooks`,
  `--safe-mode`, `--bare`). A `claude -p` run can load the mod with
  `--plugin-dir`, but mod prompts count toward `--max-turns`.
- **Poll cost**: one short `node` process every 2 seconds. Fine for a guardian;
  for many peers, prefer the bridge or raise the poll interval in
  `hooks/register.js`.

## Verify and develop

```bash
claude plugin validate ./claude-plugin
```

Edits to `hooks/register.js` hot-reload after the current turn. The generated
types in `.claude-plugin/types/` describe the exact API of your Claude Code
version; check them before using newer mods APIs.

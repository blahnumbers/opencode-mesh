# Claude Code bridge

Serve a mesh peer from Claude Code. An OpenCode session can `mesh_send` to the
bridge peer and Claude answers; Claude can send to any OpenCode session with the
mesh CLI. Both directions use the same outbox, receipts, and prefix.

No OpenCode plugin changes are needed on the Claude side: the bridge is a
separate process that claims rows for a peer marked `transport: "external"`.

> For an interactive session you keep open, use the [Claude Code mod](claude-code-mod.md)
> instead: it injects messages into the same conversation and needs no second
> process. The bridge remains the right tool for unattended runs and cron.

## Quick start

```bash
# from the repo (or a global install of opencode-mesh)
npm run build
npx mesh-claude-bridge --peer claude-reviewer --model haiku --cwd /path/to/repo
```

The bridge registers `claude-reviewer` and starts polling. From any OpenCode
session:

```text
mesh_send({ target: "claude-reviewer", text: "Review branch feat/x at <sha>" })
```

The receipt is `via: "queued"` (external peers always queue; there is no host
route to dial). The bridge claims the row, runs Claude, and Claude replies by
running:

```bash
node /path/to/opencode-mesh/bin/cli.js send <sender-session-id> "<reply body>" --json
```

`SESSION_ID` is set to the bridge peer id in Claude's environment, so the reply
is attributed to `claude`. The reply lands in the sender's session as a normal
mesh message.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--peer <id>` | `claude-reviewer` | Mesh peer id the bridge answers for. |
| `--agent <name>` | `claude` | Agent label in peers and sender headers. |
| `--model <alias\|name>` | `haiku` | Claude model. Use `opus` for final reviews. |
| `--cwd <dir>` | current | Working directory Claude runs in. |
| `--session <uuid>` | persisted | Existing Claude session to resume. |
| `--fresh` | off | New Claude session per message (no continuity). |
| `--allowed-tools <csv>` | read-only + mesh CLI | Pre-approved tools. |
| `--permission-mode <mode>` | unset | Claude permission mode. |
| `--poll-ms <n>` | `2000` | Outbox poll cadence. |
| `--timeout-ms <n>` | `300000` | Per-message Claude timeout. |
| `--once` | off | Drain one row and exit. |
| `--cli <path>` | repo `bin/cli.js` | Mesh CLI used by the reply leg. |

Env equivalents: `MESH_CLAUDE_PEER`, `MESH_CLAUDE_AGENT`, `MESH_CLAUDE_MODEL`,
`MESH_CLAUDE_CWD`, `MESH_CLAUDE_SESSION`, `MESH_CLAUDE_ALLOWED_TOOLS`,
`MESH_CLAUDE_PERMISSION_MODE`, `MESH_CLAUDE_POLL_MS`, `MESH_CLAUDE_TIMEOUT_MS`,
`MESH_CLAUDE_BIN`.

Default allowed tools are read-only plus the mesh CLI:

```text
Read,Grep,Glob,Bash(node *),Bash(git diff *),Bash(git log *),Bash(git status *),Bash(git show *)
```

Adjust them for the role. A reviewer that must not edit files should keep this
set; a fixer needs `Edit`/`Write` and a writable worktree.

## Sessions, arrival, and cost

- By default the bridge reuses one Claude session and persists its id at
  `<mesh root>/claude-bridge-<peer>.json` (0600). Restarting the bridge resumes
  where it left off. `--fresh` creates a new session per message. If the Claude
  session is deleted (`claude rm`), remove that state file or use `--fresh`.
- Delivery is serial per bridge. For parallel reviews, run one bridge per PR
  with a distinct `--peer` and `--session`/`--fresh`.
- Long Claude runs are protected by a claim heartbeat every 10 seconds, so the
  30-second stale-claim sweep cannot redeliver an in-flight message.
- A failed run releases the row for retry; after 25 attempts it is
  dead-lettered and audited (`outbox.claim-terminal`).
- `--model haiku` is cheap for wiring tests; reviews on `opus` cost
  materially more per PR.

## Registering the peer by hand

The bridge registers itself. If you need the same identity from a shell:

```bash
SESSION_ID=claude-reviewer npx opencode-mesh register --agent claude --transport external "Claude Code reviewer"
```

`register` honours `--id`, or a non-default `SESSION_ID`, and accepts
`--transport external` so sends queue instead of dialing a host route.

## Guardian pattern

Treat the agent as an advisory reviewer, not the merge gate:

- Keep tests, lint, build, and branch protection or a pre-receive hook as the
  deterministic gate.
- Give the reviewer a read-only clone/worktree and no push rights to main.
- Have the worker send `{repo, worktree, branch, base, sha, checklist}` and
  require a recorded verdict; a separate deterministic step merges.
- Use one persistent guardian session for policy questions and one fresh
  session per PR for review isolation.

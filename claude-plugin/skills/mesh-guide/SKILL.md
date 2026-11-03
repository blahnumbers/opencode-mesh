---
name: mesh-guide
description: Use when sending or replying to OpenCode mesh messages from this Claude Code session, or when deciding whether a message should wake the peer. Covers mesh_send/mesh_peers/mesh_inbox, the text field, silent/noReply semantics, and reply targets.
---

# Mesh messaging from this session

This Claude Code session is a peer on the OpenCode mesh. The peer id is shown by
`/mesh` (default `claude-guardian`). Workers on other sessions talk to you over
the mesh, and you answer them the same way.

## Receiving messages

- A mesh message arrives as a user turn whose first line is:

  ```
  [OC-MESH | SENDER: <agent> - <session-id>]
  ```

- Reply to the **session id in the header**, not to the agent name.
- A header containing `(SILENT)` is a history-only deposit. It may have been
  woken by `/mesh wake-silent on`; otherwise it is read with the `mesh_inbox`
  tool or `/mesh`.
- If no reply is needed, do nothing.

## Sending messages

- Use the `mesh_send` tool with `{ target, text }`.
  - `target`: the exact `ses_...` id from a header, or an external peer id such
    as `claude-guardian`. Use `mesh_peers` to discover sessions.
  - `text`: the message body. `message` is accepted as an alias, but prefer
    `text`.
- Send body text only. Never hand-write the `[OC-MESH | SENDER: ...]` header;
  the mesh adds it, and a hand-written one is treated as a spoofed lookalike.
- Keep replies concrete: name the branch/commit you reviewed, the verdict, and
  any must-fix items.

## Silent vs waking messages

- `silent: true` (CLI `--no-reply`, legacy `noReply`) means **history-only**:
  the peer will **not** start a turn. The message sits in its inbox until
  someone reads it. Use it only for FYI, archival, or "no action needed" notes.
- Omit `silent` for anything that needs action: review requests, verdicts,
  questions, handoffs, merge notices, blockers.
- If you receive a silent message that actually needs action, reply to the
  sender and say so; do not assume they read the original.
- The receiver controls silent delivery: `/mesh wake-silent on|off` persists on
  the receiving session. A silent message may therefore arrive as a turn with
  `(SILENT)` in the header.

## Tools

| Tool | Use |
| --- | --- |
| `mesh_send` | Send a message: `{ target, text, silent? }`. |
| `mesh_peers` | List peers with session id, agent, repo, and liveness. |
| `mesh_inbox` | Read pending messages for this session without marking them read (includes silent deposits). |
| `/mesh` | Show peer id, wake-silent setting, and pending messages. |
| `/mesh wake-silent on\|off` | Persist whether silent deposits start turns. |

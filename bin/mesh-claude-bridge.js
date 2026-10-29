#!/usr/bin/env node
// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Heartbeat-free bridge entry: claims mesh rows for an external peer and
// injects them into a Claude Code session via `claude -p`.
import { resolve } from "node:path";

const args = process.argv.slice(2);
const take = (name) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const raw = args[i];
  if (raw.includes("=")) return raw.slice(raw.indexOf("=") + 1);
  const value = args[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
};
const has = (name) => args.includes(`--${name}`);

if (has("help") || args.includes("-h")) {
  console.log(`mesh-claude-bridge — serve a mesh peer from Claude Code

Usage: mesh-claude-bridge [options]

  --peer <id>              Mesh peer id to answer for (default claude-reviewer)
  --agent <name>           Agent label in peers/headers (default claude)
  --model <alias|name>     Claude model (default haiku; use opus for reviews)
  --cwd <dir>              Working directory Claude runs in (default cwd)
  --session <uuid>         Existing Claude session to resume
  --fresh                  New Claude session per message (no continuity)
  --allowed-tools <csv>    Pre-approved tools (default read-only + mesh CLI)
  --permission-mode <mode> Claude permission mode (default unset)
  --poll-ms <n>            Outbox poll cadence (default 2000)
  --timeout-ms <n>         Per-message Claude timeout (default 300000)
  --once                   Drain one row and exit
  --cli <path>             Mesh CLI path for the reply leg

Env: MESH_CLAUDE_PEER, MESH_CLAUDE_AGENT, MESH_CLAUDE_MODEL, MESH_CLAUDE_CWD,
     MESH_CLAUDE_SESSION, MESH_CLAUDE_ALLOWED_TOOLS, MESH_CLAUDE_PERMISSION_MODE,
     MESH_CLAUDE_POLL_MS, MESH_CLAUDE_TIMEOUT_MS`);
  process.exit(0);
}

const peer = take("peer") ?? process.env.MESH_CLAUDE_PEER ?? "claude-reviewer";
const agent = take("agent") ?? process.env.MESH_CLAUDE_AGENT ?? "claude";
const model = take("model") ?? process.env.MESH_CLAUDE_MODEL ?? "haiku";
const cwd = resolve(take("cwd") ?? process.env.MESH_CLAUDE_CWD ?? process.cwd());
const sessionId = take("session") ?? process.env.MESH_CLAUDE_SESSION;
const fresh = has("fresh");
const allowedToolsRaw =
  take("allowed-tools") ?? process.env.MESH_CLAUDE_ALLOWED_TOOLS ?? "";
const allowedTools = (
  allowedToolsRaw ||
  "Read,Grep,Glob,Bash(node *),Bash(git diff *),Bash(git log *),Bash(git status *),Bash(git show *)"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const permissionMode = take("permission-mode") ?? process.env.MESH_CLAUDE_PERMISSION_MODE;
const pollMs = Number(take("poll-ms") ?? process.env.MESH_CLAUDE_POLL_MS ?? "2000");
const timeoutMs = Number(take("timeout-ms") ?? process.env.MESH_CLAUDE_TIMEOUT_MS ?? "300000");
const once = has("once");
const cliPath = take("cli") ? resolve(take("cli")) : "";

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

const { startClaudeBridge } = await import("../dist/bridge/claudeCode.js");
try {
  await startClaudeBridge({
    peerId: peer,
    agent,
    model,
    cwd,
    claudeBin: process.env.MESH_CLAUDE_BIN ?? "claude",
    cliPath,
    sessionId,
    fresh,
    allowedTools,
    permissionMode,
    pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 2000,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300000,
    once,
    log,
  });
} catch (err) {
  console.error(`mesh-claude-bridge: ${err?.message ?? err}`);
  process.exit(1);
}

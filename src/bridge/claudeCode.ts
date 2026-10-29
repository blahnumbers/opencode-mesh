// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Claude Code bridge: an external mesh peer served by `claude -p`.
// The bridge registers itself with `transport: "external"` (so sends queue
// instead of dialing a host session route), claims rows targeted at its peer
// id, and injects each message into a Claude Code session. Claude replies by
// running the mesh CLI with SESSION_ID set to the bridge peer id.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTBOX_MAX_ATTEMPTS, OUTBOX_POLL_MS } from "../constants.js";
import { EXTERNAL_TRANSPORT } from "../external.js";
import { formatMeshPrefix, quarantineText } from "../frontmatter.js";
import { ack, claim, failRow, release, releaseOwner, requeueStale, touchClaim, type OutboxRow } from "../outbox.js";
import {
  appendDeliveryAudit,
  atomicUpdateRegistry,
  heartbeat,
  normalizeEntry,
} from "../registry.js";
import { resolveMeshRoot, sanitizeSessionId } from "../xdg.js";

/** Refresh cadence for an in-flight claim; the claimer requeues at 30s. */
const CLAIM_TOUCH_MS = 10_000;
/** Heartbeat cadence for the external peer, matching the mesh registry tick. */
const REGISTRY_HEARTBEAT_MS = 5 * 60 * 1000;
/** Captured stdout/stderr cap per delivery; a runaway transcript never grows unbounded. */
const OUTPUT_CAP = 200_000;

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => ChildProcess;

export interface ClaudeBridgeConfig {
  /** Mesh peer id the bridge answers for, e.g. claude-reviewer. */
  peerId: string;
  /** Agent label shown in peers and the sender header. */
  agent: string;
  /** Claude model alias or full name; alias keeps tests cheap. */
  model: string;
  /** Working directory Claude runs in. */
  cwd: string;
  /** Claude Code binary. */
  claudeBin: string;
  /** Mesh CLI used by Claude for the reply leg. */
  cliPath: string;
  /** Existing Claude session id; otherwise created and persisted under the mesh root. */
  sessionId?: string;
  /** Create a new Claude session per delivered message instead of resuming. */
  fresh: boolean;
  /** Tools pre-approved for headless runs. */
  allowedTools: string[];
  /** Optional Claude permission mode. */
  permissionMode?: string;
  pollMs: number;
  timeoutMs: number;
  /** Drain one row then exit (test and cron friendly). */
  once: boolean;
  meshRoot?: string;
  log: (line: string) => void;
  /** Test seam: replace the child process spawner. */
  spawnFn?: SpawnFn;
}

export interface ClaudeRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Constant system prompt: the wire format and the exact reply command. */
export function meshReplyInstructions(peerId: string, cliPath: string): string {
  return [
    `You are "${peerId}", an external peer on the OpenCode mesh.`,
    `Messages arrive with a "[OC-MESH | SENDER: <agent> - <session-id>]" first line.`,
    `To discover peers: node ${cliPath} peers --json`,
    `To reply to a sender, run exactly:`,
    `  node ${cliPath} send <sender-session-id> "<reply body>" --json`,
    `SESSION_ID is already set to "${peerId}" for this process, so do not prefix it.`,
    `Use the sender session id from the header. Body text only; the CLI adds the header.`,
    `Your final text answer is not delivered to anyone: only the CLI sends a message.`,
    `Never invent a session id and never hand-write an [OC-MESH ...] header.`,
    `If no reply is needed, do nothing. Do not modify files unless the message asks for it.`,
  ].join("\n");
}

/** Claude argv for one headless turn; prompt travels on stdin, never argv. */
export function buildClaudeArgs(
  config: Pick<ClaudeBridgeConfig, "model" | "allowedTools" | "permissionMode" | "cliPath" | "peerId">,
  sessionId: string,
  resuming: boolean,
): string[] {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--model",
    config.model,
    "--append-system-prompt",
    meshReplyInstructions(config.peerId, config.cliPath),
  ];
  if (config.allowedTools.length > 0) args.push("--allowedTools", config.allowedTools.join(","));
  if (config.permissionMode) args.push("--permission-mode", config.permissionMode);
  args.push(resuming ? "--resume" : "--session-id", sessionId);
  return args;
}

export interface ClaudeEnvelope {
  result?: string;
  session_id?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}

/** Best-effort parse of the JSON envelope `--output-format json` prints. */
export function parseClaudeEnvelope(stdout: string): ClaudeEnvelope {
  const parse = (text: string): ClaudeEnvelope => {
    try {
      const value = JSON.parse(text) as unknown;
      return value && typeof value === "object" ? (value as ClaudeEnvelope) : {};
    } catch {
      return {};
    }
  };
  const text = stdout.trim();
  if (!text) return {};
  const direct = parse(text);
  if (Object.keys(direct).length > 0) return direct;
  const start = text.lastIndexOf("\n{");
  return start === -1 ? {} : parse(text.slice(start + 1));
}

function sessionStatePath(meshRoot: string, peerId: string): string {
  return resolve(meshRoot, `claude-bridge-${peerId}.json`);
}

function loadSessionId(meshRoot: string, peerId: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(sessionStatePath(meshRoot, peerId), "utf8")) as {
      sessionId?: unknown;
    };
    if (typeof raw.sessionId === "string" && raw.sessionId.length > 0) return raw.sessionId;
  } catch {}
  return undefined;
}

function saveSessionId(meshRoot: string, peerId: string, sessionId: string): void {
  try {
    writeFileSync(
      sessionStatePath(meshRoot, peerId),
      JSON.stringify({ sessionId, savedAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch {
    // Session continuity degrades to a fresh session; delivery still works.
  }
}

/** Register or refresh the external peer row; preserves any stored title. */
export async function registerExternalPeer(
  config: Pick<ClaudeBridgeConfig, "peerId" | "agent" | "model" | "cwd">,
  meshRoot?: string,
): Promise<void> {
  await atomicUpdateRegistry((reg) => {
    const prev = reg[config.peerId];
    const label = `Claude Code bridge (${config.model})`;
    reg[config.peerId] = normalizeEntry({
      sessionId: config.peerId,
      agent: config.agent,
      transport: EXTERNAL_TRANSPORT,
      directory: config.cwd,
      description: prev?.description ?? label,
      summary: prev?.summary ?? label,
      title: prev?.title ?? label,
      updatedAt: Date.now(),
    });
  }, meshRoot);
}

/** Run one headless Claude turn with the message on stdin. Never throws. */
export function runClaude(
  config: ClaudeBridgeConfig,
  sessionId: string,
  resuming: boolean,
  prompt: string,
): Promise<ClaudeRunResult> {
  const spawnFn = (config.spawnFn ?? spawn) as SpawnFn;
  const args = buildClaudeArgs(config, sessionId, resuming);
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise(result);
    };
    let child: ChildProcess;
    try {
      child = spawnFn(config.claudeBin, args, {
        cwd: config.cwd,
        env: { ...process.env, SESSION_ID: config.peerId },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolvePromise({
        code: 1,
        signal: null,
        stdout: "",
        stderr: String((err as Error)?.message ?? err),
        timedOut: false,
        durationMs: Date.now() - started,
      });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    }, config.timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish({
        code: 1,
        signal: null,
        stdout,
        stderr: `${stderr}\n${String((err as Error)?.message ?? err)}`.trim(),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    // Why: stdin, not argv — mesh bodies reach 1MB and ARG_MAX would clip them.
    try {
      child.stdin?.end(prompt);
    } catch {}
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One delivery attempt; returns true when the row settled (acked or terminal). */
async function deliverRow(
  config: ClaudeBridgeConfig,
  row: OutboxRow,
  owner: string,
): Promise<boolean> {
  const meshRoot = config.meshRoot;
  const touch = setInterval(() => {
    void touchClaim(row.id, owner, meshRoot).catch(() => {});
  }, CLAIM_TOUCH_MS);
  touch.unref?.();
  try {
    const stored = config.fresh ? undefined : (config.sessionId ?? loadSessionId(resolveMeshRoot(), config.peerId));
    const sessionId = stored ?? randomUUID();
    const resuming = stored !== undefined;
    if (!config.fresh) saveSessionId(resolveMeshRoot(), config.peerId, sessionId);
    config.log(
      `[bridge] deliver ${row.id} -> ${sessionId}${resuming ? " (resume)" : " (new)"} from ${row.from_session}`,
    );
    // Queue rows store the body only; the wire prefix is applied at injection
    // time by every other claim leg, so the bridge owns it here too.
    const prefixed = `${formatMeshPrefix(row.from_agent, row.from_session, true, row.silent === 1)}\n\n${quarantineText(row.text)}`;
    const result = await runClaude(config, sessionId, resuming, prefixed);
    const envelope = parseClaudeEnvelope(result.stdout);
    const ok = result.code === 0 && !result.timedOut && envelope.is_error !== true;
    if (ok) {
      await ack(row.id, owner, meshRoot);
      const said = typeof envelope.result === "string" ? envelope.result.replace(/\s+/g, " ").slice(0, 120) : "";
      config.log(
        `[bridge] delivered ${row.id} in ${result.durationMs}ms` +
          (typeof envelope.total_cost_usd === "number" ? ` $${envelope.total_cost_usd.toFixed(4)}` : "") +
          (said ? ` | ${said}` : ""),
      );
      await appendDeliveryAudit(
        "outbox.injected",
        {
          id: row.id,
          target_session: row.target_session,
          owner,
          attempts: row.attempts,
          maxAttempts: OUTBOX_MAX_ATTEMPTS,
          via: "claude-bridge",
          model: config.model,
          durationMs: result.durationMs,
        },
        meshRoot,
      );
      return true;
    }
    const why = result.timedOut
      ? "timeout"
      : `exit ${result.code ?? "signal"}: ${(envelope.result ?? result.stderr).slice(0, 300)}`;
    config.log(`[bridge] failed ${row.id}: ${why}`);
    if (row.attempts + 1 >= OUTBOX_MAX_ATTEMPTS) {
      await failRow(row.id, owner, "max-attempts", undefined, meshRoot);
      await appendDeliveryAudit(
        "outbox.claim-terminal",
        { id: row.id, target_session: row.target_session, owner, via: "claude-bridge", reason: why },
        meshRoot,
      );
      return true;
    }
    await release(row.id, owner, meshRoot);
    await appendDeliveryAudit(
      "outbox.claim-deferred",
      { id: row.id, target_session: row.target_session, owner, via: "claude-bridge", reason: why },
      meshRoot,
    );
    return false;
  } finally {
    clearInterval(touch);
  }
}

/** Run the bridge until stopped (or one row in once mode). */
export async function startClaudeBridge(config: ClaudeBridgeConfig): Promise<void> {
  sanitizeSessionId(config.peerId);
  const meshRoot = config.meshRoot ?? resolveMeshRoot();
  const owner = `${config.peerId}#bridge-${process.pid}-${randomUUID().slice(0, 8)}`;
  const effective: ClaudeBridgeConfig = {
    ...config,
    meshRoot,
    cliPath: config.cliPath || fileURLToPath(new URL("../../bin/cli.js", import.meta.url)),
  };
  await registerExternalPeer(effective, meshRoot);
  const hb = setInterval(() => {
    void heartbeat(effective.peerId, meshRoot).catch(() => {});
  }, REGISTRY_HEARTBEAT_MS);
  hb.unref?.();

  let stopped = false;
  let inFlight = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    config.log("[bridge] stopping after the current delivery");
  };
  const onSignal = () => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  config.log(
    `[bridge] peer=${effective.peerId} agent=${effective.agent} model=${effective.model} cwd=${effective.cwd}`,
  );
  try {
    while (!stopped) {
      await requeueStale(undefined, meshRoot).catch(() => 0);
      let rows: OutboxRow[] = [];
      try {
        rows = await claim([effective.peerId], owner, 1, meshRoot);
      } catch (err) {
        config.log(`[bridge] claim failed: ${String((err as Error)?.message ?? err)}`);
      }
      if (rows.length === 0) {
        if (effective.once) {
          config.log("[bridge] no rows");
          break;
        }
        await sleep(effective.pollMs);
        continue;
      }
      for (const row of rows) {
        inFlight = true;
        try {
          await deliverRow(effective, row, owner);
        } finally {
          inFlight = false;
        }
        if (effective.once) {
          stopped = true;
          break;
        }
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    clearInterval(hb);
    if (!inFlight) await releaseOwner(owner, meshRoot).catch(() => 0);
  }
}

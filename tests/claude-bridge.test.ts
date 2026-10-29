// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Claude Code bridge: argument shape, envelope parsing, external registration,
// and one end-to-end once-mode delivery with a stubbed spawner (no real Claude
// call in the suite).
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  prompt = "";
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    end: (text: string) => {
      this.prompt = text;
      if (this.auto) queueMicrotask(() => this.finish());
    },
  };
  constructor(
    private readonly exitCode: number = 0,
    private readonly envelope: Record<string, unknown> = { result: "ok" },
    private readonly auto = true,
  ) {
    super();
  }
  finish(): void {
    this.stdout.emit("data", Buffer.from(JSON.stringify(this.envelope)));
    this.emit("close", this.exitCode, null);
  }
  fail(message: string): void {
    this.stderr.emit("data", Buffer.from(message));
    this.emit("error", new Error(message));
  }
  kill(signal?: string): void {
    this.emit("close", null, signal ?? "SIGKILL");
  }
}

let root = "";
let restore: () => void = () => {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mesh-claude-bridge-"));
  const prevRoot = process.env.OPENCODE_MESH_ROOT;
  process.env.OPENCODE_MESH_ROOT = root;
  restore = () => {
    if (prevRoot === undefined) delete process.env.OPENCODE_MESH_ROOT;
    else process.env.OPENCODE_MESH_ROOT = prevRoot;
  };
  vi.resetModules();
});

afterEach(async () => {
  restore();
  await rm(root, { recursive: true, force: true });
  vi.resetModules();
});

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    peerId: "claude-reviewer",
    agent: "claude",
    model: "haiku",
    cwd: "/tmp",
    claudeBin: "claude",
    cliPath: "/x/opencode-mesh/bin/cli.js",
    fresh: true,
    allowedTools: ["Read", "Bash(node *)"],
    pollMs: 5,
    timeoutMs: 5000,
    once: true,
    meshRoot: root,
    log: () => {},
    ...overrides,
  };
}

describe("claude bridge argument shape", () => {
  it("carries the reply command and the no-final-text rule", async () => {
    const { meshReplyInstructions } = await import("../src/bridge/claudeCode.js");
    const text = meshReplyInstructions("claude-reviewer", "/x/cli.js");
    expect(text).toContain("node /x/cli.js send <sender-session-id>");
    expect(text).toContain("node /x/cli.js peers --json");
    expect(text).toContain('SESSION_ID is already set to "claude-reviewer"');
    expect(text).toContain("final text answer is not delivered");
    expect(text).not.toContain("SESSION_ID=claude-reviewer node");
  });

  it("resumes an existing session and starts a new one otherwise", async () => {
    const { buildClaudeArgs } = await import("../src/bridge/claudeCode.js");
    const base = {
      model: "haiku",
      allowedTools: ["Read", "Bash(node *)"],
      cliPath: "/x/cli.js",
      peerId: "claude-reviewer",
    };
    const resumed = buildClaudeArgs(base, "abc", true);
    expect(resumed).toContain("--resume");
    expect(resumed).toContain("abc");
    expect(resumed).not.toContain("--session-id");
    expect(resumed.join(" ")).toContain("--allowedTools Read,Bash(node *)");
    expect(resumed.join(" ")).toContain("--output-format json");
    const fresh = buildClaudeArgs(base, "def", false);
    expect(fresh).toContain("--session-id");
    expect(fresh).toContain("def");
    expect(buildClaudeArgs({ ...base, permissionMode: "default" }, "x", false)).toContain(
      "--permission-mode",
    );
  });

  it("parses the JSON envelope with or without trailing noise", async () => {
    const { parseClaudeEnvelope } = await import("../src/bridge/claudeCode.js");
    expect(parseClaudeEnvelope('{"result":"ok","total_cost_usd":0.1}')).toMatchObject({
      result: "ok",
      total_cost_usd: 0.1,
    });
    expect(parseClaudeEnvelope('log line\n{"result":"late"}')).toMatchObject({ result: "late" });
    expect(parseClaudeEnvelope("not json")).toEqual({});
    expect(parseClaudeEnvelope("")).toEqual({});
  });

  it("registers the peer with the external transport marker", async () => {
    const { registerExternalPeer } = await import("../src/bridge/claudeCode.js");
    const { readRegistry } = await import("../src/registry.js");
    await registerExternalPeer(
      { peerId: "claude-reviewer", agent: "claude", model: "haiku", cwd: "/tmp/repo" },
      root,
    );
    const reg = await readRegistry();
    expect(reg["claude-reviewer"]).toMatchObject({
      agent: "claude",
      transport: "external",
      directory: "/tmp/repo",
    });
  });
});

describe("claude bridge delivery", () => {
  it("injects the prefixed body and acks a once-mode row", async () => {
    const { enqueue, claim } = await import("../src/outbox.js");
    const { startClaudeBridge } = await import("../src/bridge/claudeCode.js");
    await enqueue({
      target_session: "claude-reviewer",
      from_session: "ses-sender",
      from_agent: "manager",
      text: "ping from worker",
    });
    const spawns: Array<{ args: readonly string[]; env: Record<string, string>; child: FakeChild }> = [];
    const spawnFn = ((_cmd: string, args: readonly string[], opts: { env: Record<string, string> }) => {
      const child = new FakeChild(0, { result: "replied", total_cost_usd: 0.001 });
      spawns.push({ args, env: opts.env, child });
      return child as unknown as ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;

    await startClaudeBridge(baseConfig({ spawnFn }) as never);

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.child.prompt).toContain("[OC-MESH | SENDER: manager - ses-sender]");
    expect(spawns[0]?.child.prompt).toContain("ping from worker");
    expect(spawns[0]?.env.SESSION_ID).toBe("claude-reviewer");
    expect(spawns[0]?.args).toContain("--session-id");
    expect(await claim(["claude-reviewer"], "other-owner", 5)).toHaveLength(0);
    const audit = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(root, "audit.log"), "utf8"),
    );
    expect(audit).toContain("claude-bridge");
  });

  it("releases a failed row for redelivery", async () => {
    const { enqueue, claim } = await import("../src/outbox.js");
    const { startClaudeBridge } = await import("../src/bridge/claudeCode.js");
    await enqueue({
      target_session: "claude-reviewer",
      from_session: "ses-sender",
      from_agent: "manager",
      text: "will fail",
    });
    const spawnFn = (() => new FakeChild(1, { result: "boom", is_error: true })) as unknown as typeof import("node:child_process").spawn;
    await startClaudeBridge(baseConfig({ spawnFn }) as never);
    const rows = await claim(["claude-reviewer"], "other-owner", 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.fail_reason).toBeNull();
  });
});

describe("runClaude transport edges", () => {
  it("returns a typed failure when spawn throws", async () => {
    const { runClaude } = await import("../src/bridge/claudeCode.js");
    const spawnFn = (() => {
      throw new Error("ENOENT claude");
    }) as unknown as typeof import("node:child_process").spawn;
    const res = await runClaude(baseConfig({ spawnFn }) as never, "id", false, "hi");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("ENOENT");
  });

  it("surfaces a child error event as a failure", async () => {
    const { runClaude } = await import("../src/bridge/claudeCode.js");
    const child = new FakeChild(0, { result: "ok" }, false);
    const spawnFn = (() => {
      queueMicrotask(() => child.fail("spawn boom"));
      return child as unknown as ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
    const res = await runClaude(baseConfig({ spawnFn }) as never, "id", false, "hi");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("spawn boom");
  });

  it("marks a run that exceeds the timeout", async () => {
    const { runClaude } = await import("../src/bridge/claudeCode.js");
    const child = new FakeChild(0, { result: "ok" }, false);
    const spawnFn = (() => child as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
    const res = await runClaude(baseConfig({ spawnFn, timeoutMs: 25 }) as never, "id", false, "hi");
    expect(res.timedOut).toBe(true);
  });
});

describe("claude bridge session continuity", () => {
  it("persists the session id and resumes it on the next run", async () => {
    const { enqueue } = await import("../src/outbox.js");
    const { startClaudeBridge } = await import("../src/bridge/claudeCode.js");
    const seen: string[][] = [];
    const spawnFn = ((_cmd: string, args: readonly string[]) => {
      seen.push([...args]);
      return new FakeChild(0, { result: "ok" }) as unknown as ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
    const config = baseConfig({ spawnFn, fresh: false }) as never;
    await enqueue({
      target_session: "claude-reviewer",
      from_session: "ses-sender",
      from_agent: "manager",
      text: "one",
    });
    await startClaudeBridge(config);
    await enqueue({
      target_session: "claude-reviewer",
      from_session: "ses-sender",
      from_agent: "manager",
      text: "two",
    });
    await startClaudeBridge(config);
    expect(seen).toHaveLength(2);
    const first = seen[0] ?? [];
    const second = seen[1] ?? [];
    const firstId = first[first.indexOf("--session-id") + 1];
    const secondId = second[second.indexOf("--resume") + 1];
    expect(first).toContain("--session-id");
    expect(second).toContain("--resume");
    expect(secondId).toBe(firstId);
  });

  it("exits cleanly in once mode when the outbox is empty", async () => {
    const { startClaudeBridge } = await import("../src/bridge/claudeCode.js");
    const logs: string[] = [];
    const spawnFn = (() => {
      throw new Error("no spawn expected");
    }) as unknown as typeof import("node:child_process").spawn;
    await startClaudeBridge(baseConfig({ spawnFn, log: (l: string) => logs.push(l) }) as never);
    expect(logs.join("\n")).toContain("no rows");
  });

  it("dead-letters after the attempt bound instead of releasing forever", async () => {
    const { enqueue, claim, release } = await import("../src/outbox.js");
    const { startClaudeBridge } = await import("../src/bridge/claudeCode.js");
    const id = await enqueue({
      target_session: "claude-reviewer",
      from_session: "ses-sender",
      from_agent: "manager",
      text: "always fails",
    });
    for (let i = 0; i < 24; i++) {
      const rows = await claim(["claude-reviewer"], "seed", 1);
      if (rows.length === 0) break;
      await release(rows[0]!.id, "seed");
    }
    const spawnFn = (() =>
      new FakeChild(1, { result: "boom", is_error: true }) as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
    await startClaudeBridge(baseConfig({ spawnFn }) as never);
    expect(await claim(["claude-reviewer"], "other-owner", 5)).toHaveLength(0);
    const audit = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(root, "audit.log"), "utf8"),
    );
    expect(audit).toContain("claim-terminal");
    void id;
  });
});

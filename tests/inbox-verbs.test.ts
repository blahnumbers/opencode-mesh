// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Inbox verbs: a peek never claims, and a wake claim leaves silent deposits
// queued for the agent's mesh_inbox tool instead of starting a turn.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root = "";
let restore: () => void = () => {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mesh-inbox-"));
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

async function seed(peer = "claude-guardian"): Promise<{ wake: string; quiet: string }> {
  const { enqueue } = await import("../src/outbox.js");
  const wake = await enqueue({
    target_session: peer,
    from_session: "ses-worker",
    from_agent: "build",
    text: "wake me",
  });
  const quiet = await enqueue({
    target_session: peer,
    from_session: "ses-worker",
    from_agent: "build",
    text: "just a note",
    silent: true,
  });
  return { wake, quiet };
}

describe("inbox peek", () => {
  it("lists undelivered rows without claiming or bumping attempts", async () => {
    await seed();
    const { listPending } = await import("../src/outbox.js");
    const first = await listPending(["claude-guardian"], 10);
    expect(first.map((r) => r.text)).toEqual(["wake me", "just a note"]);
    expect(first.every((r) => r.claimed_by === null && r.attempts === 0)).toBe(true);
    const second = await listPending(["claude-guardian"], 10);
    expect(second).toHaveLength(2);
  });

  it("can filter to wake rows only", async () => {
    await seed();
    const { listPending } = await import("../src/outbox.js");
    const rows = await listPending(["claude-guardian"], 10, { wakeOnly: true });
    expect(rows.map((r) => r.text)).toEqual(["wake me"]);
  });
});

describe("inbox claim", () => {
  it("wake-only claim leaves the silent row for the peek path", async () => {
    const { wake, quiet } = await seed();
    const { claim, listPending, ack } = await import("../src/outbox.js");
    const claimed = await claim(["claude-guardian"], "owner-a", 10, undefined, { wakeOnly: true });
    expect(claimed.map((r) => r.id)).toEqual([wake]);
    const pending = await listPending(["claude-guardian"], 10);
    expect(pending.map((r) => r.id)).toEqual([quiet]);
    await ack(wake, "owner-a");
  });

  it("a plain claim still takes silent rows", async () => {
    const { quiet } = await seed();
    const { claim } = await import("../src/outbox.js");
    const claimed = await claim(["claude-guardian"], "owner-b", 10);
    expect(claimed.some((r) => r.id === quiet)).toBe(true);
  });

  it("ack only settles for the owning claimer", async () => {
    await seed();
    const { claim, ack, listPending } = await import("../src/outbox.js");
    const [row] = await claim(["claude-guardian"], "owner-c", 1);
    expect(row).toBeDefined();
    expect(await ack(row!.id, "someone-else")).toBe(false);
    expect(await ack(row!.id, "owner-c")).toBe(true);
    const pending = await listPending(["claude-guardian"], 10);
    expect(pending.some((r) => r.id === row!.id)).toBe(false);
  });
});

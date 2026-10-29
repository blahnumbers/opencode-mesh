// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// External-peer routing: a peer whose registry row says transport=external is
// served by its own bridge, so sends must queue for it and never dial a host
// session route that cannot exist.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origFetch = globalThis.fetch;
let root = "";
let restore: () => void = () => {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mesh-external-"));
  const prevRoot = process.env.OPENCODE_MESH_ROOT;
  const prevDb = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, "empty.db");
  restore = () => {
    if (prevRoot === undefined) delete process.env.OPENCODE_MESH_ROOT;
    else process.env.OPENCODE_MESH_ROOT = prevRoot;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
    else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  };
  vi.resetModules();
});

afterEach(async () => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  restore();
  await rm(root, { recursive: true, force: true });
  vi.resetModules();
});

describe("external marker", () => {
  it("classifies only the external transport value", async () => {
    const { isExternalPeer } = await import("../src/external.js");
    expect(isExternalPeer(undefined)).toBe(false);
    expect(isExternalPeer(null)).toBe(false);
    expect(isExternalPeer({ transport: "opencode" })).toBe(false);
    expect(isExternalPeer({ transport: "external" })).toBe(true);
  });
});

describe("external peer sends", () => {
  it("queues without dialing a session route and stores the body only", async () => {
    const { atomicUpdateRegistry } = await import("../src/registry.js");
    await atomicUpdateRegistry((reg) => {
      reg["caller"] = { sessionId: "caller", agent: "manager", updatedAt: Date.now() };
      reg["claude-reviewer"] = {
        sessionId: "claude-reviewer",
        agent: "claude",
        transport: "external",
        updatedAt: Date.now(),
      };
    });
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      throw new Error("no host server");
    }) as unknown as typeof fetch;

    const { mesh_send } = await import("../src/tools/mesh_send.js");
    const result = (await (
      mesh_send.execute as unknown as (
        a: unknown,
        b: unknown,
      ) => Promise<{ output: string }>
    )({ target: "claude-reviewer", text: "review this branch" }, {
      sessionID: "caller",
      directory: "/tmp",
      agent: "manager",
    }));
    const out = JSON.parse(result.output) as { via: string; id: string };

    expect(out.via).toBe("queued");
    // Only liveness probes may run; the host has no route for this peer.
    expect(calls.every((u) => u.includes("/session/status") || u.includes("/api/session/active"))).toBe(true);
    expect(calls.some((u) => u.includes("prompt"))).toBe(false);

    const { claim } = await import("../src/outbox.js");
    const rows = await claim(["claude-reviewer"], "test-owner", 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("review this branch");
    expect(rows[0]?.from_session).toBe("caller");
    await claim([], "test-owner");
  });
});

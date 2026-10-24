// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Zero-config v2 discovery: the service publishes its random port and Basic
// password to <state>/opencode/service.json. Given that file, when mesh probes
// or sends, then the port and header come from the live service instead of a
// static 4096 pin or an env the plugin never saw.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "OPENCODE_MESH_SERVICE_STATE",
  "OPENCODE_PORT",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_MESH_KEYCHAIN_PROVIDER",
] as const;

let saved: Record<string, string | undefined> = {};
let root = "";

beforeEach(async () => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  root = await mkdtemp(join(tmpdir(), "mesh-service-state-suite-"));
  process.env.OPENCODE_MESH_SERVICE_STATE = join(root, "service.json");
  vi.resetModules();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true });
  vi.resetModules();
});

async function writeState(body: unknown): Promise<void> {
  await writeFile(join(root, "service.json"), JSON.stringify(body), "utf8");
  const { resetServiceStateCache } = await import("../src/serviceState.js");
  resetServiceStateCache();
}

describe("service state discovery", () => {
  it("parses the live url port plus password", async () => {
    await writeState({ url: "http://127.0.0.1:49374", password: "pw-live", pid: 42 });
    const { readServiceState } = await import("../src/serviceState.js");
    expect(readServiceState()).toEqual({
      url: "http://127.0.0.1:49374",
      port: 49374,
      password: "pw-live",
    });
  });

  it("treats absent, corrupt, and portless files as misses", async () => {
    const { readServiceState, resetServiceStateCache } = await import("../src/serviceState.js");
    expect(readServiceState()).toBeNull();
    await writeState({ url: "http://127.0.0.1:49374", password: "pw" });
    expect(readServiceState()?.port).toBe(49374);
    await writeFile(join(root, "service.json"), "{not json", "utf8");
    resetServiceStateCache();
    expect(readServiceState()).toBeNull();
    await writeState({ url: "http://127.0.0.1", password: "pw" });
    expect(readServiceState()).toBeNull();
  });

  it("re-reads a rewritten file instead of memoizing the first port", async () => {
    await writeState({ url: "http://127.0.0.1:49374", password: "pw" });
    const { readServiceState } = await import("../src/serviceState.js");
    expect(readServiceState()?.port).toBe(49374);
    await writeState({ url: "http://127.0.0.1:51001", password: "pw" });
    expect(readServiceState()?.port).toBe(51001);
  });

  it("resolveOpencodePort: env wins, service next, 4096 when neither exists", async () => {
    const { resolveOpencodePort } = await import("../src/constants.js");
    expect(resolveOpencodePort()).toBe(4096);
    await writeState({ url: "http://127.0.0.1:49374", password: "pw" });
    expect(resolveOpencodePort()).toBe(49374);
    process.env.OPENCODE_PORT = "4321";
    expect(resolveOpencodePort()).toBe(4321);
  });

  it("serverAuth adopts the service password when no env credential is set", async () => {
    await writeState({ url: "http://127.0.0.1:49374", password: "pw-live" });
    const { getServerAuthHeaderSync, getServerAuthHeader } = await import("../src/serverAuth.js");
    const expected = `Basic ${Buffer.from("opencode:pw-live").toString("base64")}`;
    expect(getServerAuthHeaderSync()).toBe(expected);
    expect(await getServerAuthHeader()).toBe(expected);
    process.env.OPENCODE_SERVER_PASSWORD = "pw-env";
    expect(getServerAuthHeaderSync()).toBe(
      `Basic ${Buffer.from("opencode:pw-env").toString("base64")}`,
    );
    delete process.env.OPENCODE_SERVER_PASSWORD;
    // An explicit port names a different server; never leak this credential to it.
    process.env.OPENCODE_PORT = "4097";
    expect(getServerAuthHeaderSync()).toBeUndefined();
  });
});

describe("v2 SPA shell detection", () => {
  it("demotes only explicit text/html answers", async () => {
    const { isSpaShellResponse, isV1StatusResponse } = await import("../src/httpProbe.js");
    const html = new Response("<!doctype html><html></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const json = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const bare = { ok: true } as unknown as Response;
    expect(isSpaShellResponse(html)).toBe(true);
    expect(isV1StatusResponse(html)).toBe(false);
    expect(isSpaShellResponse(json)).toBe(false);
    expect(isV1StatusResponse(json)).toBe(true);
    // Optimistic default: headerless mocks and older hosts keep v1 behavior.
    expect(isV1StatusResponse(bare)).toBe(true);
  });

  it("probePort marks a v2 SPA answer unreachable and fingerprints nothing", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    try {
      const { probePort } = await import("../src/enumerate.js");
      const sight = await probePort(49374, 500);
      expect(sight.reachable).toBe(false);
      expect(sight.fingerprint).toBe("");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

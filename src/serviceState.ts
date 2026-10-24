// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// OpenCode v2 background-service state.
// The shared service writes its live loopback URL and Basic-auth password to
// <state>/opencode/service.json on every start. Reading it here is what makes
// mesh zero-config on v2 hosts: the port is random and the password is not in
// the plugin's environment, so probing 4096 or omitting the header can never
// reach the server the user is actually running.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ServiceState {
  /** Loopback base the service published, e.g. http://127.0.0.1:49374. */
  url: string;
  /** Port parsed from `url`; always 1..65535. */
  port: number;
  /** Basic-auth password the service requires; absent when auth is disabled. */
  password?: string;
}

/** Explicit override used by tests and by hosts that relocate their state dir. */
const SERVICE_STATE_ENV = "OPENCODE_MESH_SERVICE_STATE";
/** Re-stat cadence: the file is rewritten on every service start, never within a second. */
const CACHE_TTL_MS = 1000;

let cached: { at: number; mtimeMs: number; state: ServiceState | null } | null = null;

/** Service state path: explicit override, then XDG state home, then ~/.local/state. */
export function resolveServiceStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[SERVICE_STATE_ENV]?.trim();
  if (explicit) return resolve(explicit);
  const xdg = env.XDG_STATE_HOME?.trim();
  const base = xdg ? resolve(xdg) : resolve(homedir(), ".local", "state");
  return resolve(base, "opencode", "service.json");
}

function parseState(raw: unknown): ServiceState | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const url = typeof rec.url === "string" ? rec.url : "";
  const match = url.match(/:(\d+)\/?$/);
  const port = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const password =
    typeof rec.password === "string" && rec.password.length > 0 ? rec.password : undefined;
  return { url, port, ...(password !== undefined ? { password } : {}) };
}

/**
 * Live service state, or null when no service file exists (v1 hosts, tests,
 * service stopped). Never throws: a corrupt or half-written file is a miss.
 */
export function readServiceState(now: number = Date.now()): ServiceState | null {
  const path = resolveServiceStatePath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cached = null;
    return null;
  }
  if (cached && cached.mtimeMs === mtimeMs && now - cached.at < CACHE_TTL_MS) return cached.state;
  let state: ServiceState | null = null;
  try {
    state = parseState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    state = null;
  }
  cached = { at: now, mtimeMs, state };
  return state;
}

/** Test seam: drop the memoized read so a rewritten file is seen on the next call. */
export function resetServiceStateCache(): void {
  cached = null;
}

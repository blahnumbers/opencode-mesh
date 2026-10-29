// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// External peer transport marker.
// Mesh normally delivers straight to an OpenCode server route. A peer whose
// registry entry carries `transport: "external"` is served by a bridge
// process (Claude Code, another agent runtime) that drains the outbox itself,
// so the send path must queue for it instead of dialing prompt_async.
export const EXTERNAL_TRANSPORT = "external";

/** True when the registry entry is served by an external bridge, not the host. */
export function isExternalPeer(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  return (entry as { transport?: unknown }).transport === EXTERNAL_TRANSPORT;
}

// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Universal ServerAuth Basic identical to opencode.
// Precedence: env, then the Keychain behind the exact opt-in flag, then the
// running v2 service's published password (automatic, no setup).
import { KEYCHAIN_USERNAME, getKeychainPassword, getKeychainPasswordAsync } from "./serverAuthKeychainProvider.js";
import { readServiceState } from "./serviceState.js";

/** v2 service password: the credential the local server actually requires. */
function servicePassword(): string | undefined {
  const state = readServiceState();
  if (!state) return undefined;
  // Why: an explicit port override names a different server; never hand that
  // host the local service's credential.
  const envPort = Number(process.env.OPENCODE_PORT);
  if (Number.isInteger(envPort) && envPort !== state.port) return undefined;
  return state.password;
}

/** Loopback Basic header, or undefined when no credential is configured. */
export function getServerAuthHeaderSync(): string | undefined {
  const envPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (envPassword) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${envPassword}`).toString("base64")}`;
  }
  if (process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER === "1") {
    const kcPassword = getKeychainPassword();
    if (kcPassword) {
      const username = process.env.OPENCODE_SERVER_USERNAME ?? KEYCHAIN_USERNAME;
      return `Basic ${Buffer.from(`${username}:${kcPassword}`).toString("base64")}`;
    }
  }
  const svcPassword = servicePassword();
  if (svcPassword) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${svcPassword}`).toString("base64")}`;
  }
  return undefined;
}

/** Async mirror with the non-blocking provider plus Linux fallback. */
export async function getServerAuthHeader(): Promise<string | undefined> {
  const envPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (envPassword) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${envPassword}`).toString("base64")}`;
  }
  if (process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER === "1") {
    const kcPassword = await getKeychainPasswordAsync();
    if (kcPassword) {
      const username = process.env.OPENCODE_SERVER_USERNAME ?? KEYCHAIN_USERNAME;
      return `Basic ${Buffer.from(`${username}:${kcPassword}`).toString("base64")}`;
    }
  }
  const svcPassword = servicePassword();
  if (svcPassword) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${svcPassword}`).toString("base64")}`;
  }
  return undefined;
}

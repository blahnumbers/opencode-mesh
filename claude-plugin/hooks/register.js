// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// mesh-guardian — a Claude Code mod that makes this session a mesh peer.
//
// The mod polls the mesh outbox every two seconds, claims one wake message,
// and submits it to the live session with $.prompt.submit({ asUser: true }).
// That starts a turn in the same conversation the user is typing in, so no
// second process, session fork, or headless bridge is involved.
//
// Silent deposits (mesh_send with silent/noReply) do not start a turn by
// default. Set MESH_CLAUDE_WAKE_SILENT=1 to deliver them too, with the
// (SILENT) marker in the header. Otherwise they stay for the mesh_inbox tool.
//
// Peer id: MESH_CLAUDE_PEER (default claude-guardian).
// Mesh CLI: MESH_CLI, else ../bin/cli.js from the plugin root.

const DEFAULT_PEER = "claude-guardian";
const POLL_MS = 2000;
const HEARTBEAT_MS = 5 * 60 * 1000;
const RETRY_MS = 30000;
const ERROR_LOG_MS = 60000;

let peer = DEFAULT_PEER;
let owner = DEFAULT_PEER + "-mod";
let cli = "";
let wakeSilent = false;
let busy = false;
let submitting = false;
let retryAt = 0;
let lastErrorAt = 0;

function parseRows(stdout) {
  try {
    const value = JSON.parse(stdout);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

async function mesh($, args) {
  // SESSION_ID makes the CLI attribute the call to this peer instead of the
  // generic "cli" identity (which the direct leg would quarantine).
  return await $.process.run(["node", cli, ...args], { env: { SESSION_ID: peer } });
}

async function registerPeer($) {
  try {
    const registered = await mesh($, [
      "register",
      "--id",
      peer,
      "--agent",
      "claude",
      "--transport",
      "external",
      "Claude Code guardian",
    ]);
    if (registered.exitCode !== 0) {
      $.ui.log("mesh: register exited " + registered.exitCode + ": " + registered.stderr);
    }
  } catch (error) {
    $.ui.log("mesh: register failed: " + errorText(error));
  }
}

function formatMessage(row) {
  const header =
    "[OC-MESH | SENDER" +
    (row.silent ? " (SILENT)" : "") +
    ": " +
    row.from_agent +
    " - " +
    row.from_session +
    "]";
  return (
    header +
    "\n\n" +
    row.text +
    '\n\n---\n(mesh) Reply to this sender with the mesh_send tool: target "' +
    row.from_session +
    '".'
  );
}

async function poll($) {
  if (busy || submitting || Date.now() < retryAt) return;
  let listed;
  try {
    const args = ["inbox", "--peer", peer, "--claim"];
    if (!wakeSilent) args.push("--wake");
    args.push("--owner", owner, "--json", "--limit", "1");
    listed = await mesh($, args);
  } catch (error) {
    if (Date.now() - lastErrorAt > ERROR_LOG_MS) {
      lastErrorAt = Date.now();
      $.ui.log("mesh: inbox failed: " + errorText(error));
    }
    return;
  }
  const rows = parseRows(listed.stdout);
  if (rows.length === 0) return;
  const row = rows[0];
  submitting = true;
  busy = true;
  $.ui.log("mesh: injecting " + row.id + " from " + row.from_session);
  try {
    const answer = await $.prompt.submit({ text: formatMessage(row), asUser: true });
    if (answer && answer.drop) {
      // Interrupted session or run limit: keep the row for a later attempt.
      retryAt = Date.now() + RETRY_MS;
      busy = false;
      $.ui.log("mesh: submit dropped: " + answer.drop);
      await mesh($, ["release", row.id, "--owner", owner]);
      return;
    }
    await mesh($, ["ack", row.id, "--owner", owner]);
  } catch (error) {
    retryAt = Date.now() + RETRY_MS;
    busy = false;
    try {
      await mesh($, ["release", row.id, "--owner", owner]);
    } catch {}
    $.ui.log("mesh: delivery deferred: " + errorText(error));
  } finally {
    submitting = false;
  }
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    peer = (await $.env.get("MESH_CLAUDE_PEER")) || DEFAULT_PEER;
    owner = peer + "-mod";
    wakeSilent = (await $.env.get("MESH_CLAUDE_WAKE_SILENT")) === "1";
    const root = (await $.env.get("CLAUDE_PLUGIN_ROOT")) || "";
    cli = (await $.env.get("MESH_CLI")) || root + "/../bin/cli.js";

    await $.tool.register({
      name: "mesh_send",
      description:
        "Send a message to another OpenCode mesh peer. Use the session id from a message header or mesh_peers.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Peer session id (ses_...) or external peer id" },
          text: { type: "string", description: "Body text only; the mesh adds the sender header" },
          silent: { type: "boolean", description: "Deposit without waking the target agent" },
        },
        required: ["target", "text"],
      },
    });

    await $.tool.register({
      name: "mesh_peers",
      description: "List mesh peers with session id, agent, repo, and liveness.",
      inputSchema: { type: "object", properties: {}, required: [] },
    });

    await $.tool.register({
      name: "mesh_inbox",
      description:
        "Read pending mesh messages for this session without marking them read (includes silent deposits).",
      inputSchema: { type: "object", properties: {}, required: [] },
    });

    await $.command.register({
      name: "mesh",
      description: "Show this mesh peer's pending messages and wake-silent setting",
    });

    $.ui.log("mesh: peer=" + peer + " cli=" + cli + (wakeSilent ? " (wake-silent)" : ""));
    await registerPeer($);
    $.clock.every(POLL_MS, () => poll($));
    $.clock.every(HEARTBEAT_MS, () => registerPeer($));
    return next(e);
  }).catch(async ($, e, next) => {
    // A failed init must never block the user's session.
    $.ui.log("mesh: init failed: " + String(next.error && next.error.kind ? next.error.kind : "error"));
    return next(e);
  });

  on("command.run", { command: "mesh" }, async ($) => {
    const pending = await mesh($, ["inbox", "--peer", peer, "--json"]);
    const rows = parseRows(pending.stdout);
    const lines = [
      "mesh peer: " + peer,
      "pending: " + rows.length + (wakeSilent ? " (wake-silent on)" : " (silent rows wait for mesh_inbox)"),
    ];
    for (const row of rows.slice(0, 5)) {
      lines.push(
        "- " +
          (row.silent ? "[silent] " : "") +
          row.from_agent +
          " " +
          row.from_session +
          ": " +
          row.text.slice(0, 80).replace(/\s+/g, " "),
      );
    }
    return { text: lines.join("\n") };
  });

  on("prompt.submit", async ($, e, next) => {
    // The user (or a submit) is back: clear the interrupt backoff.
    retryAt = 0;
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    busy = true;
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    busy = false;
    return next(e);
  });

  on("tool.call", { tool: "mcp__mesh-guardian__mesh_send" }, async ($, e) => {
    const args = ["send", e.target, e.text, "--json"];
    if (e.silent) args.push("--no-reply");
    const res = await mesh($, args);
    return { result: res.exitCode === 0 ? res.stdout : res.stderr || "mesh_send failed" };
  });

  on("tool.call", { tool: "mcp__mesh-guardian__mesh_peers" }, async ($) => {
    const res = await mesh($, ["peers", "--json"]);
    return { result: res.exitCode === 0 ? res.stdout : res.stderr || "mesh_peers failed" };
  });

  on("tool.call", { tool: "mcp__mesh-guardian__mesh_inbox" }, async ($) => {
    const res = await mesh($, ["inbox", "--peer", peer, "--json"]);
    return { result: res.exitCode === 0 ? res.stdout : res.stderr || "mesh_inbox failed" };
  });
}

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
const STATUS_MS = 30000;

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
    '". See the mesh skill for conventions.'
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

async function refreshStatus($) {
  try {
    const pending = await mesh($, ["inbox", "--peer", peer, "--json"]);
    const rows = parseRows(pending.stdout);
    if (rows.length === 0) {
      $.ui.status(undefined);
      return;
    }
    const silent = rows.filter((row) => row.silent).length;
    $.ui.status(
      "mesh: " + rows.length + " pending" + (silent > 0 ? " (" + silent + " silent — /mesh)" : ""),
    );
  } catch {
    // Status is advisory; a failed peek must not surface as an error.
  }
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    peer = (await $.env.get("MESH_CLAUDE_PEER")) || DEFAULT_PEER;
    owner = peer + "-mod";
    const storedWake = await $.store.get("wakeSilent");
    wakeSilent = (await $.env.get("MESH_CLAUDE_WAKE_SILENT")) === "1" || storedWake === true;
    const root = (await $.env.get("CLAUDE_PLUGIN_ROOT")) || "";
    cli = (await $.env.get("MESH_CLI")) || root + "/../bin/cli.js";

    await $.tool.register({
      name: "mesh_send",
      description:
        "Send a message to another OpenCode mesh peer. target is the exact ses_... id from an [OC-MESH | SENDER] header (or an external peer id). Put the body in text; message is accepted as an alias. Omit silent for anything that needs a reply or action; silent:true is history-only and will not wake the peer.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Peer session id (ses_...) or external peer id" },
          text: {
            type: "string",
            description: "Message body only; the mesh adds the sender header. Use text (message is an alias).",
          },
          silent: {
            type: "boolean",
            description:
              "History-only deposit: the peer will NOT start a turn. Omit for review requests, verdicts, questions, handoffs, or anything needing action.",
          },
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
        "Read pending mesh messages for this session without marking them read. Includes silent deposits, which do not start turns on their own.",
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
    $.clock.every(STATUS_MS, () => refreshStatus($));
    return next(e);
  }).catch(async ($, e, next) => {
    // A failed init must never block the user's session.
    $.ui.log("mesh: init failed: " + String(next.error && next.error.kind ? next.error.kind : "error"));
    return next(e);
  });

  on("command.run", { command: "mesh" }, async ($, e) => {
    const words = String(e.args || "").trim().split(/\s+/).filter(Boolean);
    if (words[0] === "wake-silent") {
      const enable = words[1] === "on";
      const disable = words[1] === "off";
      if (!enable && !disable) return { text: "usage: /mesh wake-silent on|off" };
      wakeSilent = enable;
      await $.store.set("wakeSilent", enable);
      return {
        text: enable
          ? "mesh: wake-silent ON — silent deposits now start turns (persisted)"
          : "mesh: wake-silent OFF — silent deposits wait for /mesh or mesh_inbox (persisted)",
      };
    }
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
    // "message" is accepted as an alias: models sometimes pick it over "text",
    // and an undefined argv entry makes process.run throw, which the host
    // reports as "no tool.call hook answered".
    const text =
      typeof e.text === "string" ? e.text : typeof e.message === "string" ? e.message : "";
    if (typeof e.target !== "string" || e.target.length === 0) {
      return { result: 'mesh_send needs target: the "ses_..." id or external peer id.' };
    }
    if (text.length === 0) {
      return {
        result:
          'mesh_send needs the body in "text" (for example {"target":"ses_...","text":"..."}); "message" is accepted as an alias.',
      };
    }
    try {
      const args = ["send", e.target, text, "--json"];
      if (e.silent) args.push("--no-reply");
      const res = await mesh($, args);
      return { result: res.exitCode === 0 ? res.stdout : res.stderr || "mesh_send failed" };
    } catch (error) {
      return { result: "mesh_send failed: " + errorText(error) };
    }
  });

  on("tool.call", { tool: "mcp__mesh-guardian__mesh_peers" }, async ($) => {
    try {
      const res = await mesh($, ["peers", "--json"]);
      return { result: res.exitCode === 0 ? res.stdout : res.stderr || "mesh_peers failed" };
    } catch (error) {
      return { result: "mesh_peers failed: " + errorText(error) };
    }
  });

  on("tool.call", { tool: "mcp__mesh-guardian__mesh_inbox" }, async ($) => {
    try {
      const res = await mesh($, ["inbox", "--peer", peer, "--json"]);
      return { result: res.exitCode === 0 ? res.stdout : res.stderr || "mesh_inbox failed" };
    } catch (error) {
      return { result: "mesh_inbox failed: " + errorText(error) };
    }
  });
}

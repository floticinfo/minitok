"use strict";

const { postJson } = require("../core/http");

/**
 * Run delegation — one-time, run-scoped entitlement authorization.
 *
 * The extension host holds an admin session in VS Code SecretStorage, which a
 * spawned CLI child cannot read. Before spawning `run`, the extension asks the
 * server (with the admin token) for a short-lived delegation token bound to the
 * runId, and passes it through the child environment only — never argv.
 *
 * The CLI verifies the token against the server exactly once; the server burns
 * it on verification, so a replayed token can never authorize a second run.
 * The raw admin token itself never crosses the process boundary.
 */

const DELEGATION_ENV = "MINITOK_RUN_DELEGATION";

function takeDelegationTokenFromEnv() {
  const token = process.env[DELEGATION_ENV];
  // Scrub immediately: the pipeline may spawn grandchildren (shell commands
  // authored by the LLM), and a leaked delegation token would let them mint
  // runs without a plan. Reading it once and deleting it right away keeps the
  // exposure window to this process only.
  delete process.env[DELEGATION_ENV];
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

function delegationGateResult({ state, message, delegated, runId, runIds, entitlement }) {
  return {
    allowed: state === "ALLOWED",
    state,
    message,
    delegated: delegated === true,
    ...(runId ? { delegationRunId: runId } : {}),
    ...(Array.isArray(runIds) ? { delegationRunIds: runIds } : {}),
    ...(entitlement ? { entitlement } : {}),
  };
}

/**
 * Verify a run delegation token against the server.
 *
 * The extension issues the token bound to the runId it is about to spawn, and
 * `minitok run` may retry the same invocation (same runId) after a crash. The
 * server therefore accepts an optional `run_ids` list: every id in it must
 * match the token's binding or verification fails closed.
 */
async function verifyRunDelegation(token, options = {}) {
  const serverUrl = options.serverUrl;
  if (!serverUrl) {
    return delegationGateResult({ state: "SERVER_REJECTED", message: "Run delegation requires a configured entitlement server.", delegated: false, runId: undefined, runIds: undefined, entitlement: undefined });
  }
  const runIds = Array.isArray(options.runIds) && options.runIds.every(id => typeof id === "string" && id.trim())
    ? options.runIds.map(id => id.trim())
    : (typeof options.runId === "string" && options.runId.trim() ? [options.runId.trim()] : undefined);
  const body = { token, ...(runIds ? { run_ids: runIds } : {}) };
  try {
    const response = await (options._verify || ((url, payload) => postJson(url, JSON.stringify(payload), 10000)))(`${serverUrl.replace(/\/$/, "")}/v1/run-delegation/verify`, body);
    if (response?.ok && response.body?.valid === true) {
      const entitlement = {
        plan_id: "admin",
        delegated: true,
        features: ["run"],
      };
      return delegationGateResult({
        state: "ALLOWED",
        message: "Run authorized by a one-time admin delegation.",
        delegated: true,
        runId: /** @type {string|undefined} */ (response.body.run_id),
        runIds: /** @type {string[]|undefined} */ (response.body.run_ids),
        entitlement,
      });
    }
    const detail = response?.body?.error || "The run delegation token was rejected by the server.";
    return delegationGateResult({ state: "SERVER_REJECTED", message: detail, delegated: false, runId: undefined, runIds: undefined, entitlement: undefined });
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ERR_INVALID_URL") {
      return delegationGateResult({ state: "SERVER_REJECTED", message: "Run delegation verification response was invalid.", delegated: false, runId: undefined, runIds: undefined, entitlement: undefined });
    }
    // No offline grace for delegation: the whole point is a single online
    // verification that burns the token. Reusing an offline grace window to
    // admit a delegated admin run would defeat the one-time contract.
    return delegationGateResult({ state: "SERVER_UNREACHABLE", message: `The run delegation could not be verified: ${error?.message || "server unavailable"}.`, delegated: false, runId: undefined, runIds: undefined, entitlement: undefined });
  }
}

module.exports = { DELEGATION_ENV, takeDelegationTokenFromEnv, verifyRunDelegation };
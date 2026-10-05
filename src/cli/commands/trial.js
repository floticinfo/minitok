"use strict";

/**
 * minitok trial — Request a free trial activation key (email only, no card).
 *
 * Calls POST /v1/trial/request with an email address and displays the
 * plaintext trial activation key exactly once. Optionally activates the
 * returned key on this installation in the same step.
 */

const { resolveServerUrl } = require("./server-config");
const { postJson } = require("../../core/http");
const { printError } = require("../output");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Request a trial key for an email address.
 * @param {object} opts
 * @param {string} opts.email - Email address (required)
 * @param {string} [opts.server] - minitok server URL
 * @param {boolean} [opts.activate] - Activate the returned key immediately
 * @returns {Promise<number>} Exit code
 */
async function cmdTrial(opts) {
  const email = typeof opts?.email === "string" ? opts.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) {
    printError("A valid email address is required.\n");
    console.error("Usage: minitok trial --email you@example.com [--activate] [--server <url>]");
    return 1;
  }

  const serverUrl = resolveServerUrl({ cliServer: opts?.server });
  const idempotencyKey = generateIdempotencyKey(email);

  let result;
  try {
    result = await _httpPost(`${serverUrl}/v1/trial/request`, {
      email,
      idempotency_key: idempotencyKey,
    });
  } catch (err) {
    printError(`Cannot connect to server at ${serverUrl}\n${err.message}`);
    return 1;
  }

  if (!result.ok) {
    printError(`${result.body?.error || "Trial request failed"}`);
    return 1;
  }

  const body = result.body || {};
  if (body.already_issued) {
    console.log("");
    console.log("A trial key was already issued for this email/idempotency key.");
    console.log("For security the key is not displayed again. If you lost it, contact");
    console.log("support or start a new trial with a different idempotency key.");
    console.log("");
    return 0;
  }

  const key = body.activation_key;
  if (!key) {
    printError("Server did not return an activation key.");
    return 1;
  }

  console.log("");
  console.log("Your free trial activation key (shown once):");
  console.log(key);
  console.log("");
  console.log(`  Trial: ${body.plan_id || "trial"} — ${body.run_quota || 5} runs, ${body.trial_days || 14} days, telemetry OFF`);
  if (body.expires_at) console.log(`  Expires: ${body.expires_at}`);
  console.log("");

  if (opts?.activate === true) {
    console.log("Activating now...\n");
    const { cmdActivate } = require("./activate");
    return cmdActivate(key, { server: opts?.server });
  }

  console.log("Activate with: minitok activate " + key);
  return 0;
}

/**
 * Deterministic idempotency key per email so an accidental double-submit
 * does not burn a second trial slot; the server treats a repeat as a replay
 * (already_issued) instead of issuing a second key.
 */
function generateIdempotencyKey(email) {
  const { createHash } = require("crypto");
  const hostname = require("os").hostname();
  return "trial-" + createHash("sha256").update(`minitok-trial:${email}:${hostname}`).digest("hex").slice(0, 32);
}

function _httpPost(urlString, body) {
  return postJson(urlString, body, 30000);
}

module.exports = { cmdTrial, _httpPost };

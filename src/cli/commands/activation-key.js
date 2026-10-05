"use strict";

/**
 * minitok activation-key — Retrieve your activation key.
 *
 * Calls POST /v1/activation-key with the customer JWT and returns the
 * plaintext activation key (exactly once) for a Dodo subscription payment.
 */

const { resolveServerUrl } = require("./server-config");
const { postJson } = require("../../core/http");
const { loadCustomerToken } = require("../../auth/customer-token");
const { ensureAccountSession } = require("./account");
const { printError } = require("../output");

/**
 * Retrieve the activation key for the authenticated customer.
 * @param {object} opts
 * @param {string} [opts.token] - Customer JWT (required)
 * @param {string} [opts.payment] - Optional Dodo payment ID
 * @param {string} [opts.server] - minitok server URL
 * @returns {Promise<number>} Exit code
 */
async function cmdActivationKey(opts) {
  const serverUrl = resolveServerUrl({ cliServer: opts?.server });
  const account = opts?.token ? null : await ensureAccountSession({ server: opts?.server });
  const token = opts?.token || account?.access_token || loadCustomerToken();
  if (!token) {
    printError("Authentication token required.");
    console.error("Usage: minitok activation-key --token <JWT> [--payment <dodo_payment_id>]");
    return 1;
  }

  // Send the JWT to POST /v1/activation-key
  const body = {};
  if (opts?.payment) body.dodo_payment_id = opts.payment;

  let result;
  try {
    result = await _httpPost(serverUrl + "/v1/activation-key", body, {
      Authorization: "Bearer " + token,
    });
  } catch (err) {
    printError("Cannot connect to server at " + serverUrl);
    console.error(err.message);
    return 1;
  }

  if (!result.ok) {
    printError("" + (result.body?.error || "Activation key retrieval failed"));
    return 1;
  }

  const { activation_key } = result.body;
  if (!activation_key) {
    printError("Server did not return an activation key.");
    return 1;
  }

  console.log("");
  console.log("Your activation key:");
  console.log(activation_key);
  console.log("");
  console.log("Activate with: minitok activate <activation-key>");
  return 0;
}

function _httpPost(urlString, body, headers) {
  return postJson(urlString, body, 30000, headers);
}

module.exports = { cmdActivationKey, _httpPost };

const { resolveServerUrl } = require("./server-config");
const { postJson } = require("../../core/http");
const { loadCustomerToken } = require("../../auth/customer-token");
const { ensureAccountSession } = require("./account");

async function cmdCheckout(opts) {
  const serverUrl = resolveServerUrl({ cliServer: opts?.server });
  const envToken = opts?.tokenEnv && /^[A-Z_][A-Z0-9_]*$/i.test(opts.tokenEnv) ? process.env[opts.tokenEnv] : undefined;
  const account = opts?.token || envToken ? null : await ensureAccountSession({ server: opts?.server });
  const token = opts?.token || envToken || account?.access_token || loadCustomerToken();
  if (!token) {
    console.error("Error: Authentication token required.");
    console.error("Usage: minitok checkout --token <JWT> [--plan open]");
    return 1;
  }

  const planId = opts?.plan || "open";
  if (planId !== "open") {
    console.error("Error: Only the Open plan is available for purchase.");
    return 1;
  }
  const endpoint = "/v1/checkout/dodo";
  if (!opts?.json) console.log("[run] Creating checkout session for plan: " + planId + " (" + endpoint + ")");

  let result;
  try {
    result = await _httpPost("" + serverUrl + endpoint,
      { planId },
      { Authorization: "Bearer " + token });
  } catch (err) {
    console.error("Error: Cannot connect to server at " + serverUrl);
    console.error(err.message);
    return 1;
  }

  if (!result.ok) {
    console.error("[error] " + (result.body?.error || "Checkout failed"));
    return 1;
  }

  const { checkout_url } = result.body;
  if (!checkout_url) {
    console.error("Error: Server did not return a checkout URL.");
    return 1;
  }

  if (opts?.json) console.log(JSON.stringify({ checkout_url }));
  else {
    console.log("");
    console.log("[ok] Checkout URL:");
    console.log(checkout_url);
    console.log("");
    console.log("Open the URL above to complete your purchase.");
  }
  return 0;
}

function _httpPost(urlString, body, headers) {
  return postJson(urlString, body, 30000, headers);
}

module.exports = { cmdCheckout };

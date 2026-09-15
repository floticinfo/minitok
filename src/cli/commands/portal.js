const { resolveServerUrl } = require("./server-config");
const { postJson } = require("../../core/http");
const { loadCustomerToken } = require("../../auth/customer-token");
const { ensureAccountSession } = require("./account");

async function cmdPortal(opts) {
  const serverUrl = resolveServerUrl({ cliServer: opts?.server });
  const envToken = opts?.tokenEnv && /^[A-Z_][A-Z0-9_]*$/i.test(opts.tokenEnv) ? process.env[opts.tokenEnv] : undefined;
  const account = opts?.token || envToken ? null : await ensureAccountSession({ server: opts?.server });
  const token = opts?.token || envToken || account?.access_token || loadCustomerToken();
  if (!token) {
    console.error("Error: Authentication token required.");
    console.error("Usage: minitok portal --token <JWT>");
    return 1;
  }

  const endpoint = "/v1/portal/dodo";
  if (!opts?.json) console.log("Opening Dodo billing portal...");

  let result;
  try {
    result = await _httpPost("" + serverUrl + endpoint,
      {},
      { Authorization: "Bearer " + token });
  } catch (err) {
    console.error("Error: Cannot connect to server at " + serverUrl);
    console.error(err.message);
    return 1;
  }

  if (!result.ok) {
    console.error("Error: " + (result.body?.error || "Portal failed"));
    return 1;
  }

  const { portal_url } = result.body;
  if (!portal_url) {
    console.error("Error: Server did not return a portal URL.");
    return 1;
  }

  if (opts?.json) console.log(JSON.stringify({ portal_url }));
  else {
    console.log("");
    console.log("Billing Portal:");
    console.log(portal_url);
    console.log("");
  }
  return 0;
}

function _httpPost(urlString, body, headers) {
  return postJson(urlString, body, 30000, headers);
}

module.exports = { cmdPortal };

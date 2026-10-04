"use strict";

/**
 * minitok deactivate — Revoke the current entitlement.
 *
 * Calls DELETE /api/entitlement on the server to revoke the token, then
 * removes the local cache so the CLI stops accepting the session.
 */

const { EntitlementCache } = require("../../entitlement/cache");
const client = require("../../entitlement/client");
const { resolveServerUrl } = require("./server-config");

async function cmdDeactivate(opts = {}) {
  const serverUrl = resolveServerUrl({ cliServer: opts?.server });
  const cache = new EntitlementCache();
  const cached = cache.load({ allowStale: true });

  if (!cached || !cached.token) {
    console.log("No active entitlement found. Nothing to deactivate.");
    return 0;
  }

  // Try to revoke on the server; even if the server is unreachable we still
  // clear the local cache so the user is not stuck with a ghost session.
  try {
    const result = await client.deactivate(cached.token, { serverUrl });
    if (!result.ok) {
      const errMsg = result.body?.error || `Server returned ${result.status}`;
      console.error(`Warning: server revocation failed: ${errMsg}`);
      console.error("Local entitlement cache will still be cleared.");
    }
  } catch (err) {
    console.error(`Warning: cannot reach server: ${err.message}`);
    console.error("Local entitlement cache will still be cleared.");
  }

  cache.clear();
  console.log("[ok] Entitlement deactivated.");
  console.log(`  Server:     ${serverUrl}`);
  console.log(`  Cache file: ${cache.filePath}`);
  return 0;
}

module.exports = { cmdDeactivate };

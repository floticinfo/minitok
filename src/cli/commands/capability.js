"use strict";
const { importCapabilityToken, readCapabilityRecord, clearCapabilityRecord } = require("../../entitlement/capability");
const { resolveServerUrl } = require("./server-config");

async function cmdCapabilityImport(token, options = {}) {
  if (!token && options.tokenEnv && /^[A-Z_][A-Z0-9_]*$/i.test(options.tokenEnv)) token = process.env[options.tokenEnv];
  if (!token) { console.error("Error: capability token required. Use --token-env NAME."); return 1; }
  try {
    const result = await importCapabilityToken(token, { serverUrl: resolveServerUrl({ cliServer: options.server }), filePath: options.file });
    if (!result.success) { console.error(`Error: ${result.error}`); return 1; }
    console.log(JSON.stringify({ status: "ok", profile: result.record.profile, installation_id: result.record.installation_id, expires_at: result.record.expires_at, capabilities: result.record.capabilities }));
    return 0;
  } catch (error) { console.error(`Error: capability validation failed: ${error.message}`); return 1; }
}
function cmdCapabilityStatus(options = {}) {
  const record = readCapabilityRecord({ filePath: options.file });
  if (!record) { if (options.json) console.log(JSON.stringify({ status: "missing" })); else console.log("Capability profile: missing"); return 1; }
  const result = { status: "valid", profile: record.profile, installation_id: record.installation_id, expires_at: record.expires_at, capabilities: record.capabilities, server_url: record.server_url };
  console.log(options.json ? JSON.stringify(result) : `Capability profile: ${result.profile}\nInstallation: ${result.installation_id}\nExpires: ${result.expires_at}\nCapabilities: ${result.capabilities.join(", ")}`);
  return 0;
}
function cmdCapabilityClear(options = {}) { clearCapabilityRecord(options.file); console.log(JSON.stringify({ status: "cleared" })); return 0; }
module.exports = { cmdCapabilityImport, cmdCapabilityStatus, cmdCapabilityClear };

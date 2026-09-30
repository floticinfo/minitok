import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(path.join(root, "tests", "fixtures", "stage2-parity.json"), "utf8"));
const read = file => readFileSync(path.join(root, file), "utf8");
const errors = [];
const checks = [];
const pass = (name, detail) => checks.push({ name, detail, status: "verified-local" });
const fail = (name, detail) => errors.push(`${name}: ${detail}`);
const expect = (condition, name, detail) => condition ? pass(name, detail) : fail(name, detail);

const serverConfig = read("src/cli/commands/server-config.js");
const activate = read("src/cli/commands/activate.js");
const online = read("src/entitlement/online.js");
const checkout = read("src/cli/commands/checkout.js");
const activationKey = read("src/cli/commands/activation-key.js");
const publicKey = read("src/entitlement/public-key.js");
const runtimeServer = read("src/runtime/server.js");
const stdio = read("src/runtime/stdio.js");
const mcpCommand = read("src/cli/commands/mcp.js");

expect(serverConfig.includes(`const DEFAULT_SERVER_URL = "${fixture.api.defaultOrigin}"`), "production API default", fixture.api.defaultOrigin);
expect(serverConfig.includes("Remote http server URLs are not allowed") && serverConfig.includes("must not contain credentials"), "server URL safety", "remote HTTP and URL credentials rejected");
expect(activate.includes(`${fixture.api.routes.activate}`) && /key,\s*installation_id/.test(activate), "activation contract", "POST /v1/activate with key and installation_id");
expect(online.includes(`${fixture.api.routes.validate}`) && /token:\s*record\??\.token/.test(online) && /entitlement:/.test(online), "validation contract", "POST /v1/validate with token and entitlement");
expect(activationKey.includes(fixture.api.routes.activationKey) && activationKey.includes("dodo_payment_id"), "activation-key contract", fixture.api.routes.activationKey);
expect(checkout.includes(fixture.api.routes.checkout) && checkout.includes("{ planId }"), "checkout contract", fixture.api.routes.checkout);

const keyIdMatch = publicKey.match(/KEY_REGISTRY\.set\(\s*"([^"]+)"/);
const pemBase64 = publicKey.match(/MCowBQYDK2VwAyE[A-Za-z0-9+/=]+/)?.[0];
const fingerprint = pemBase64 ? createHash("sha256").update(Buffer.from(pemBase64, "base64")).digest("hex") : null;
expect(keyIdMatch?.[1] === fixture.signing.keyId, "signing key identifier", fixture.signing.keyId);
expect(fingerprint === fixture.signing.spkiSha256, "trusted public-key fingerprint", fingerprint || "missing");

expect(fixture.mcp.protocolVersions.every(protocol => stdio.includes(`"${protocol}"`)) && stdio.includes("const SUPPORTED_PROTOCOLS = ["), "MCP protocol negotiation", fixture.mcp.protocolVersions.join(", "));
expect(stdio.includes("MINITOK_MCP_AUTH_TOKEN_FILE") && stdio.includes("this._sessionToken"), "MCP stdio auth", "token file and session-bound authentication");
expect(runtimeServer.includes(`const HOST = "${fixture.mcp.httpHost}"`) && runtimeServer.includes(`routeKey !== "POST /mcp"`), "MCP HTTP localhost boundary", "loopback-only /mcp");
expect(runtimeServer.includes("Forbidden: localhost") && runtimeServer.includes("Bearer"), "MCP HTTP auth boundary", "remote socket rejection and bearer authentication");
expect(mcpCommand.includes("runtime/stdio-entry.js") && mcpCommand.includes("MINITOK_MCP_AUTH_TOKEN_FILE") && mcpCommand.includes("autoApprove: []"), "MCP stdio configuration", "packaged stdio entry, owner token file, and explicit approval default");
expect(fixture.mcp.remoteHttpAllowed === false && serverConfig.includes("Remote http server URLs are not allowed"), "localhost versus deployable service", "HTTP is local-only; HTTPS is required for remote server URLs");

const liveRequested = process.env.MINITOK_STAGE2_LIVE_SMOKE === "1";
if (liveRequested) {
  if (process.env.MINITOK_STAGE2_LIVE_URL !== fixture.api.defaultOrigin) fail("live smoke", `refused URL ${process.env.MINITOK_STAGE2_LIVE_URL || "(missing)"}; only explicit non-production convention is supported`);
  else fail("live smoke", "not run by this local parity gate; use a separately approved harness");
} else checks.push({ name: "production evidence", detail: "not contacted; runtime signer, deployed version, and live API behavior remain unverified", status: "not-verified" });

for (const check of checks) console.log(`[${check.status}] ${check.name}: ${check.detail}`);
if (errors.length) {
  console.error(`stage2 parity failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log("stage2 parity passed: local contract and boundary checks complete; production parity remains unverified");

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(path.join(root, "server.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(path.join(root, "mcp-marketplace.json"), "utf8"));
const errors = [];
const expect = (condition, message) => { if (!condition) errors.push(message); };

expect(packageJson.name === "@flotic/minitok", "package name must be @flotic/minitok");
expect(typeof packageJson.version === "string" && /^\d+\.\d+\.\d+$/.test(packageJson.version), `package version must be a semver release (got ${packageJson.version || "missing"})`);
expect(packageJson.mcpName === server.name, "package.json mcpName must exactly match server.json name");
expect(/^dev\.minitok\/[a-z0-9][a-z0-9-]*$/.test(server.name), "server name must use the verified minitok.dev domain namespace");
expect(server.version === packageJson.version, "server.json version must match package.json version");
expect(server.repository?.source === "github", "server repository source must be github");
expect(server.repository?.url === "https://github.com/floticinfo/minitok", "server repository URL is incorrect");
expect(server.websiteUrl === "https://minitok.dev/docs", "server websiteUrl must point to product documentation");
expect(server.$schema === "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", "server.json must use the official Registry schema");
expect(Array.isArray(server.packages) && server.packages.length === 1, "server.json must define exactly one npm package");
const pkg = server.packages?.[0] || {};
expect(pkg.registryType === "npm", "server package registryType must be npm");
expect(pkg.identifier === packageJson.name, "server package identifier must match package name");
expect(pkg.version === packageJson.version, "server package version must match package version");
expect(pkg.transport?.type === "stdio", "server package transport must be stdio");
expect(Array.isArray(pkg.packageArguments) && pkg.packageArguments.map(arg => arg.value).join(" ") === "mcp serve", "server packageArguments must launch minitok mcp serve");
expect(Array.isArray(pkg.environmentVariables), "server package environmentVariables must be an array");
const envNames = new Set((pkg.environmentVariables || []).map(item => item.name));
for (const name of ["MINITOK_MCP_AUTH_TOKEN_FILE", "MINITOK_MCP_SCOPES", "MINITOK_SERVER_URL"]) expect(envNames.has(name), `server metadata must document ${name}`);
expect(server.icons?.every(icon => /^https:\/\//.test(icon.src)), "all server icons must use HTTPS");
expect(!JSON.stringify(server).match(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^,}\]]{8,}/i), "server.json must not contain credential values");

expect(marketplace.server === server.name, "marketplace metadata server mismatch");
expect(marketplace.package === packageJson.name, "marketplace metadata package mismatch");
expect(marketplace.version === packageJson.version, "marketplace metadata version mismatch");
expect(marketplace.commercial?.userAuthenticationRequired === true, "marketplace metadata must disclose user authentication");
expect(marketplace.commercial?.activePaidEntitlementRequired === true, "marketplace metadata must disclose paid entitlement");
expect(marketplace.commercial?.defaultScope === "read", "marketplace default scope must be read");
expect(marketplace.safety?.autoApproveDefault === false, "marketplace metadata must declare auto-approval disabled");
expect(marketplace.safety?.tokensMustNotBePublished === true, "marketplace metadata must prohibit token publication");
expect(marketplace.privacy?.telemetryDefault === "disabled", "marketplace metadata must declare telemetry disabled by default");

if (errors.length) {
  console.error(`MCP Registry metadata failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`MCP Registry metadata valid for ${packageJson.name}@${packageJson.version}`);
console.log(`server=${server.name}; transport=stdio; package=${pkg.identifier}; paid_entitlement=true; auto_approve=false`);

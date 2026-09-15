import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import readline from "node:readline";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = root;
const skip = process.env.CI || process.env.MINITOK_NO_MCP_SETUP === "1" || process.env.MINITOK_SKIP_ONBOARDING === "1" || !process.stdin.isTTY || !process.stdout.isTTY;
if (skip) process.exit(0);
const { installRuleAndSkill, installMcpConfig, configCandidates } = require(path.join(root, "src", "mcp", "cline-integration.js"));
const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
const answer = await new Promise(resolve => rl.question("Connect minitok to Cline and add the minitok MCP workflow now? [Y/n] ", value => { rl.close(); resolve(value.trim().toLowerCase()); }));
if (answer && !["y", "yes"].includes(answer)) { console.error("minitok onboarding skipped. Run `minitok mcp setup cline --scopes read` later."); process.exit(0); }
try {
  const packageJson = require(path.join(root, "package.json"));
  const tokenFile = path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".minitok", "mcp", "runtime-token.json");
  const output = execFileSync(process.execPath, [path.join(root, "bin", "minitok.js"), "mcp", "token"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const token = JSON.parse(output);
  const config = installMcpConfig({ packageRoot, tokenFile: token.path || tokenFile, scopes: "read" });
  const guidance = installRuleAndSkill();
  console.error(JSON.stringify({ status: "configured", package: packageJson.version, config, guidance, candidates: configCandidates() }));
} catch (error) {
  console.error(`minitok onboarding skipped: ${error.message}`);
  process.exit(0);
}

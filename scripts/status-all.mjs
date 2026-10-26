
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extension = JSON.parse(fs.readFileSync(path.join(root, "extension", "package.json"), "utf8"));
const server = JSON.parse(fs.readFileSync(path.join(root, "server.json"), "utf8"));
const marketplace = JSON.parse(fs.readFileSync(path.join(root, "mcp-marketplace.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "release-manifest.json"), "utf8"));
const checks = [];
const mask = value => String(value || "").replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]").replace(/(token|secret|cookie|jwt|api[_-]?key|password)[^=:\s]*[=:]\s*[^\s,}]+/gi, "$1=[REDACTED]").slice(0, 500);
function add(name, status, detail) { checks.push({ name, status, detail: mask(detail) }); }
function run(command, args, timeout = 120000) {
  const env = { ...process.env, MINITOK_UPDATE_CHECK: "0", MINITOK_NO_COLOR: "1" };
  const invocation = process.platform === "win32" && command === "npm"
    ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args.map(arg => /[\s"]/.test(arg) ? `"${String(arg).replaceAll('"', '\\"')}"` : arg).join(" ")}`]]
    : [command, args];
  const r = process.platform === "win32" && command === "npm"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`], { cwd: root, encoding: "utf8", timeout, env })
    : spawnSync(invocation[0], invocation[1], { cwd: root, encoding: "utf8", timeout, env });
  return { ok: r.status === 0, output: mask(`${r.stdout || ""}${r.stderr || ""}`), status: r.status };
}
function git(args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
async function httpJson(url, options = {}) { try { const r = await fetch(url, { ...options, signal: AbortSignal.timeout(10000), headers: { Accept: "application/json", ...(options.headers || {}) } }); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } }
function commandCheck(name, command, args) { const r = run(command, args); add(name, r.ok ? "PASS" : "FAIL", r.ok ? "completed" : r.output); }

const branch = git(["branch", "--show-current"]); const head = git(["rev-parse", "HEAD"]); const dirty = git(["status", "--porcelain"]);
add("canonical branch", branch === "release/1.5.6-candidate" ? "PASS" : "FAIL", branch);
add("HEAD commit", head ? "INFO" : "FAIL", head);
add("working tree clean", dirty ? "FAIL" : "PASS", dirty ? `${dirty.split(/\r?\n/).length} changed paths` : "clean");
const sync = run("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"]); add("remote synchronization", sync.ok && /^0\s+0$/.test(sync.output.trim()) ? "PASS" : sync.ok ? "FAIL" : "UNVERIFIED", sync.output);
add("package version", pkg.version === "1.5.6" ? "PASS" : "FAIL", pkg.version);
add("extension version", extension.version === "0.3.3" && extension.minitok?.cliVersion === "1.5.6" ? "PASS" : "FAIL", `${extension.version}; CLI ${extension.minitok?.cliVersion}`);
add("server metadata version", server.version === pkg.version && server.packages?.[0]?.version === pkg.version ? "PASS" : "FAIL", `${server.version}/${server.packages?.[0]?.version}`);
add("MCP namespace", pkg.mcpName === "dev.minitok/minitok" && server.name === pkg.mcpName && marketplace.server === pkg.mcpName ? "PASS" : "FAIL", pkg.mcpName);
add("release manifest", manifest.release?.version === pkg.version && manifest.release?.tag === "v1.5.6" ? "PASS" : "FAIL", `${manifest.release?.version} ${manifest.release?.tag}`);
add("Git tag", git(["tag", "--list", "v1.5.6"]) === "v1.5.6" ? "PASS" : "FAIL", "v1.5.6");
const npmLatest = run("npm", ["view", pkg.name, "version", "--json"]); add("npm published latest", npmLatest.ok ? "PASS" : "UNVERIFIED", npmLatest.output || "registry unavailable");
add("npm target version availability", npmLatest.ok && /["']?1\.5\.6["']?/.test(npmLatest.output) ? "PASS" : "BLOCKED", npmLatest.ok ? npmLatest.output : "1.5.6 not published");
const vsix = path.join(root, "extension", "artifacts", `minitok-extension-${extension.version}.vsix`); add("VSIX artifact", fs.existsSync(vsix) ? "PASS" : "FAIL", fs.existsSync(vsix) ? `${path.basename(vsix)} ${createHash("sha256").update(fs.readFileSync(vsix)).digest("hex")}` : "missing");
commandCheck("typecheck", "npm", ["run", "typecheck"]);
commandCheck("lint", "npm", ["run", "lint"]);
commandCheck("CLI tests", "npm", ["test"]);
commandCheck("extension tests", "npm", ["run", "test:extension"]);
commandCheck("MCP readiness", "npm", ["run", "readiness:mcp"]);

for (const [name, url, expected] of [["production health", "https://api.minitok.dev/health", 200], ["production readyz", "https://api.minitok.dev/readyz", 200]]) { const r = await httpJson(url); add(name, r.status === expected ? "PASS" : "BLOCKED", `HTTP ${r.status}`); }
const admin = await httpJson("https://api.minitok.dev/v1/admin/me"); add("admin API unauthenticated", admin.status === 401 ? "PASS" : "FAIL", `HTTP ${admin.status}`);
const remoteMcp = await httpJson("https://api.minitok.dev/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "status-all", version: "1" } } }) }); add("remote MCP authentication", remoteMcp.status === 401 ? "PASS" : "FAIL", `HTTP ${remoteMcp.status}`);
const marketplaceResponse = await httpJson("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: "Flotic.minitok" }] }], flags: 914 }) }); add("Marketplace status", marketplaceResponse.status === 200 ? "UNVERIFIED" : "BLOCKED", marketplaceResponse.status === 200 ? "query completed; publication not proven" : `HTTP ${marketplaceResponse.status}`);
const prunable = run("git", ["worktree", "prune", "--dry-run", "--verbose"]); add("stale/prunable worktree", prunable.ok && !prunable.output.trim() ? "PASS" : "INFO", prunable.output || "none");
const worktrees = git(["worktree", "list", "--porcelain"]); const legacyDirty = worktrees.split(/\r?\n\r?\n/).filter(Boolean).filter(block => !block.includes(root)).map(block => block.split(/\r?\n/)[0]); add("dirty legacy worktree", legacyDirty.length ? "INFO" : "PASS", legacyDirty.length ? `${legacyDirty.length} legacy worktrees require manual review` : "none");
const counts = checks.reduce((a, c) => { a[c.status] = (a[c.status] || 0) + 1; return a; }, {}); const overall = counts.FAIL ? "DEGRADED" : counts.BLOCKED ? "BLOCKED" : counts.UNVERIFIED ? "RELEASE_CANDIDATE" : "READY";
const report = { generatedAt: new Date().toISOString(), project: root, overall, counts, checks };
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2)); else { console.log(`MiniTok status-all — ${overall}`); console.log("STATUS | CHECK | DETAIL"); console.log("-------|-------|-------"); for (const c of checks) console.log(`${c.status.padEnd(7)}| ${c.name.padEnd(30)}| ${c.detail}`); console.log(`Summary: PASS=${counts.PASS || 0} FAIL=${counts.FAIL || 0} BLOCKED=${counts.BLOCKED || 0} UNVERIFIED=${counts.UNVERIFIED || 0} INFO=${counts.INFO || 0}`); }
process.exitCode = 0;


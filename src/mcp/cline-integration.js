"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const MARKER = "<!-- minitok-managed: cline-integration -->";
const line = (...parts) => parts.join("\n");

function home() { return os.homedir(); }
function clineDataDir() { return process.env.CLINE_DATA_DIR || path.join(home(), ".cline", "data"); }
function configCandidates() { return [path.join(clineDataDir(), "settings", "cline_mcp_settings.json"), path.join(home(), ".cline", "mcp.json")]; }
function configPath() { return configCandidates().find(file => fs.existsSync(file)) || configCandidates()[0]; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } }
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
  const temp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}
function upsertFile(file, content) {
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8").includes(MARKER)) return false;
    const backup = `${file}.bak`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, `${content.trim()}\n`, { mode: 0o600 });
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${content.trim()}\n`, { mode: 0o600 });
  return true;
}
/**
 * @param {{ packageRoot: string, tokenFile: string, serverUrl?: string, scopes?: string }} options
 */
function installMcpConfig({ packageRoot, tokenFile, serverUrl = "https://api.minitok.dev", scopes = "read" }) {
  const file = configPath(); const data = readJson(file); const key = data.mcpServers ? "mcpServers" : data.servers ? "servers" : "mcpServers";
  const servers = data[key] && typeof data[key] === "object" && !Array.isArray(data[key]) ? data[key] : {};
  const entry = path.join(packageRoot, "src", "mcp", "cline-compat.js"); const target = path.join(packageRoot, "src", "runtime", "stdio-entry.js");
  const current = servers.minitok && typeof servers.minitok === "object" ? servers.minitok : {};
  const next = { ...current, command: process.execPath, args: [entry], env: { ...(current.env || {}), MINITOK_MCP_AUTH_TOKEN_FILE: tokenFile, minitok_server_url: serverUrl, MINITOK_MCP_SCOPES: scopes, MINITOK_MCP_TARGET_COMMAND: process.execPath, MINITOK_MCP_TARGET_ARGS: JSON.stringify([target]) }, disabled: false, autoApprove: [] };
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) { servers.minitok = next; writeAtomic(file, { ...data, [key]: servers }); }
  return { changed, file, reason: changed ? undefined : "already_configured" };
}
function installRuleAndSkill() {
  const rulePath = path.join(home(), "Documents", "Cline", "Rules", "minitok-mcp.md");
  const skillDir = path.join(home(), ".cline", "skills", "minitok"); const skillPath = path.join(skillDir, "SKILL.md");
  const rule = line(MARKER, "# minitok MCP routing", "", "For repository coding tasks, use the minitok MCP workflow before direct editor or shell tools.", "", "- For ordinary repository changes, prefer minitok_task with the absolute repository path and task.", "- Use minitok_run when advanced controls such as workspace resolution, provider_override, or explicit auto_accept are required.", "- Use minitok_status or read-only minitok tools for inspection.", "- Do not silently bypass minitok with direct editor or shell tools when a minitok tool is available.", "- If minitok MCP is unavailable, tell the user instead of pretending the verified workflow ran.", "- Keep auto_accept disabled unless the user explicitly requests it and the host grants that permission.");
  const skill = line("---", "name: minitok", "description: Run repository coding tasks through minitok MCP planning, implementation, verification, and evidence. Use for coding, bug fixes, refactors, and repository changes.", "---", MARKER, "# minitok MCP workflow", "", "Use `/minitok <task>` for the short explicit workflow.", "1. Use the minitok MCP server.", "2. For ordinary repository changes, call minitok_task with the absolute repository path and the user's task.", "3. Use minitok_run only when advanced run controls are needed.", "4. Inspect the returned plan, approval state, verification, review, repair, and evidence.", "5. Do not replace the minitok call with direct editor or shell tools.", "6. Keep auto_accept disabled unless explicitly requested and permitted by the host.");
  fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  return { rule: upsertFile(rulePath, rule), skill: upsertFile(skillPath, skill), rulePath, skillPath };
}
module.exports = { configCandidates, configPath, installRuleAndSkill, installMcpConfig, MARKER };

"use strict";

const path = require("path");
const { redactValue } = require("./evidence");

const LOCAL_CHECKS = new Set(["git_status", "git_diff", "test", "build", "typecheck", "lint", "changed_files", "protected_paths"]);
const LOCAL_COMMANDS = new Set(["npm", "npm.cmd", "node", "node.exe"]);
function normalize(value) { return typeof value === "string" ? value.replace(/\\/g, "/").replace(/^\.\//, "") : ""; }
function compareRepositoryScope({ changedFiles = [], allowedPaths = [], protectedPaths = [] }) {
  const outside_allowed = changedFiles.filter(file => allowedPaths.length > 0 && !allowedPaths.some(prefix => { const item = normalize(file); const base = normalize(prefix); return item === base || item.startsWith(`${base}/`); }));
  const protected_changed = changedFiles.filter(file => protectedPaths.some(prefix => { const item = normalize(file); const base = normalize(prefix); return item === base || item.startsWith(`${base}/`); }));
  return { valid: outside_allowed.length === 0 && protected_changed.length === 0, outside_allowed, protected_changed };
}
function evidence(kind, result = {}) { return redactValue({ evidence_id: `odd_${kind}_${Date.now()}`, kind, executed: result.executed === true, status: result.status || "unknown", exit_code: result.exit_code ?? null, duration_ms: result.duration_ms || 0, stdout: result.stdout || "", stderr: result.stderr || "", reason: result.reason || null }); }
async function collectRepositoryEvidence(repoRoot, options = {}) {
  const runCommand = options.runCommand; const list = [];
  if (typeof runCommand === "function") {
    for (const [kind, args] of [["git_status", ["status", "--porcelain"]], ["git_diff", ["diff", "--stat"]]]) {
      try { list.push(evidence(kind, { ...(await runCommand("git", args, repoRoot)), executed: true })); } catch (error) { list.push(evidence(kind, { executed: true, status: "unknown", reason: error.message })); }
    }
  } else { list.push(evidence("git_status", { reason: "Verifier not executed" }), evidence("git_diff", { reason: "Verifier not executed" })); }
  const changed = options.changedFiles || [];
  list.push(evidence("changed_files", { executed: true, status: "passed", result: changed }));
  const scope = compareRepositoryScope({ changedFiles: changed, allowedPaths: options.odd?.allowed_paths || [], protectedPaths: options.odd?.protected_paths || [] });
  list.push(evidence("protected_paths", { executed: true, status: scope.valid ? "passed" : "failed", reason: scope.valid ? null : JSON.stringify(scope) }));
  return list;
}
function requiredProgress(criteria = []) {
  const required = criteria.filter(item => item.required);
  const passed = required.filter(item => item.status === "passed").length;
  const failed = required.filter(item => item.status === "failed").length;
  const unknown = required.filter(item => item.status === "unknown").length;
  return { required_total: required.length, passed, failed, unknown, progress_ratio: required.length ? passed / required.length : 0 };
}
async function evaluateRepositoryCheck(repoRoot, config, options = {}) {
  if (!config || config.kind !== "local_command" || typeof config.command !== "string" || !Array.isArray(config.args)) return evidence("local_check", { reason: "Verifier not configured" });
  const command = path.basename(config.command).toLowerCase();
  if (!LOCAL_COMMANDS.has(command) || config.args.some(arg => typeof arg !== "string" || /[;&|<>`$()\n\r]/.test(arg))) return evidence("local_check", { reason: "Local command is not allowlisted" });
  const { commandRequest } = require("./evaluator");
  const parsed = commandRequest(config);
  if (parsed.error) return evidence("local_check", { reason: parsed.error });
  if (typeof options.runCommand !== "function") return evidence("local_check", { reason: "Verifier not executed" });
  try { const result = await options.runCommand(parsed.command, parsed.args, repoRoot, { timeout_ms: config.timeout_ms || 120000 }); const status = result.timed_out ? "unknown" : result.status === "passed" && result.exit_code === 0 ? "passed" : result.status === "failed" ? "failed" : "unknown"; return evidence("local_check", { ...result, executed: true, status }); } catch (error) { return evidence("local_check", { executed: true, status: "unknown", reason: error.message }); }
}
module.exports = { LOCAL_CHECKS, LOCAL_COMMANDS, compareRepositoryScope, collectRepositoryEvidence, evaluateRepositoryCheck, requiredProgress };

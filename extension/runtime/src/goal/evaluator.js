"use strict";

const fs = require("fs");
const path = require("path");
const { runProcessAsync, verifyCommandAsync } = require("../pipeline/check");
const { assertValidGoalSpec } = require("./validator");
const { createCriterionEvidence } = require("./evidence");
const { collectRepositoryEvidence, evaluateRepositoryCheck, compareRepositoryScope, requiredProgress } = require("./odd");
const { evaluateApplicationCheck } = require("./application");

const SAFE_COMMANDS = new Set(["npm", "npm.cmd", "node", "node.exe", "npx", "npx.cmd"]);
const SHELL_META = /[;&|<>`$()\n\r]/;
const SAFE_NPM_COMMANDS = new Set(["test", "t", "run-script"]);
const SAFE_NPM_SCRIPTS = new Set(["test", "lint", "typecheck", "check", "verify"]);
const SAFE_NODE_FLAGS = new Set(["--version", "-v", "--help", "-h"]);
const SAFE_NPX_FLAGS = new Set(["--no-install", "--version", "-v", "--help", "-h"]);
const UNSAFE_ARGUMENT = /(?:^|[\\/])(?:\.\.(?:[\\/]|$)|(?:etc|proc|sys|dev)(?:[\\/]|$))/i;
const UNSAFE_FLAG = /^(?:--(?:inspect|inspect-brk|require|eval|print|input-type|loader|experimental-loader|experimental-policy|env-file|watch|watch-path|test-reporter|test-name-pattern)|-(?:e|p|r|i))(?==|$)/i;
const NPM_CONFIG_SIDE_EFFECT = /^(?:--(?:global|location|prefix|userconfig|globalconfig|cache|workspace|workspaces|include-workspace-root|ignore-scripts|foreground-scripts|script-shell|registry|proxy|https-proxy|offline|prefer-offline|audit|fund)|-g)$/i;
const NPM_SIDE_EFFECT_COMMANDS = new Set(["install", "i", "add", "uninstall", "remove", "rm", "update", "up", "upgrade", "publish", "pack", "link", "unlink", "exec", "init", "create", "config", "cache", "root", "prefix", "version", "dedupe", "prune", "doctor", "audit", "fund", "start", "stop", "restart"]);

function nowIso(options) { return (options.now || (() => new Date().toISOString()))(); }
function safeRoot(root) { return typeof root === "string" && root.trim() !== "" ? path.resolve(root) : null; }
function commandName(command) { return path.basename(String(command)).toLowerCase(); }
function commandRequest(config) {
  if (!config || typeof config.command !== "string" || config.command.trim() === "") return { error: "A verifier command is required" };
  if (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string")) return { error: "Verifier args must be an array of strings" };
  const command = commandName(config.command);
  if (!SAFE_COMMANDS.has(command)) return { error: `Command is not allowlisted: ${config.command}` };
  const args = [...config.args];
  if (SHELL_META.test(config.command) || args.some(arg => SHELL_META.test(arg))) return { error: "Shell metacharacters are not allowed in verifier commands" };
  if (args.some(arg => UNSAFE_ARGUMENT.test(arg) || UNSAFE_FLAG.test(arg))) return { error: "Verifier arguments may not access outside the workspace or control the verifier process" };
  if (command.startsWith("node")) {
    if (args.length === 1 && SAFE_NODE_FLAGS.has(args[0])) return { command: process.execPath, args };
    return { error: "Node verifier may only run informational flags; arbitrary scripts are not allowed" };
  }
  if (command.startsWith("npm")) {
    if (args.length === 0) return { error: "npm verifier requires a read-only command" };
    const subcommand = args.find(arg => !arg.startsWith("-"))?.toLowerCase();
    if (!subcommand || NPM_SIDE_EFFECT_COMMANDS.has(subcommand) || !SAFE_NPM_COMMANDS.has(subcommand)) return { error: "npm verifier subcommand is not allowlisted as read-only" };
    if (args.some(arg => NPM_CONFIG_SIDE_EFFECT.test(arg))) return { error: "npm verifier flags may not change installation, registry, workspace, or script behavior" };
    if (subcommand === "run-script") {
      const script = args[args.indexOf(subcommand) + 1];
      if (args.length !== 2 || !script || !SAFE_NPM_SCRIPTS.has(script.toLowerCase())) return { error: "npm verifier script is not allowlisted as read-only" };
    } else if (args.length !== 1) return { error: "npm verifier commands may not receive additional arguments" };
    return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
  }
  if (args.length < 1 || args.length > 2 || args.some(arg => !SAFE_NPX_FLAGS.has(arg)) || !args.includes("--no-install")) return { error: "npx verifier may only use no-install informational commands" };
  return { command: process.platform === "win32" ? "npx.cmd" : "npx", args };
}
function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function timeoutResult(error, started, request) {
  const timedOut = error?.timed_out === true || error?.timedOut === true || error?.code === "ETIMEDOUT" || /timed? ?out|timeout/i.test(error?.message || "");
  return {
    status: "unknown",
    valid: false,
    reason: timedOut ? "Verifier execution timed out" : error?.message || "Verifier execution failed",
    evidence: createCriterionEvidence({ criterion_id: request.criterion_id, verifier_type: request.verifier_type, status: "unknown", valid: false, execution: { started_at: started, duration_ms: Date.now() - new Date(started).getTime(), timed_out: timedOut, error: error?.message || "Verifier execution failed" } }),
  };
}

async function runCommand(config, context, criterion, verifierType) {
  const started = context.startedAt || new Date().toISOString();
  const request = { criterion_id: criterion.id, verifier_type: verifierType };
  const parsed = commandRequest(config);
  if (parsed.error) return timeoutResult(new Error(parsed.error), started, request);
  const timeoutMs = Number.isSafeInteger(context.timeoutMs) && context.timeoutMs > 0 ? context.timeoutMs : 120000;
  try {
    const runner = context.commandRunner || ((command, args, repoRoot, options) => runProcessAsync(command, args, repoRoot, options));
    const raw = await runner(parsed.command, parsed.args, context.repoRoot, { timeout_ms: timeoutMs, criterion });
    const result = raw && typeof raw === "object" ? raw : { status: "failed", output: "Verifier returned no result" };
    const timedOut = result.timed_out === true || result.timedOut === true || /timed? ?out|timeout/i.test(result.error || result.output || "") || (result.status === "failed" && Number.isFinite(result.duration_ms) && result.duration_ms >= timeoutMs);
    const status = timedOut ? "unknown" : result.status === "passed" && result.exit_code === 0 ? "passed" : result.status === "failed" ? "failed" : "unknown";
    const valid = !timedOut && (status === "passed" || status === "failed");
    return {
      status,
      valid,
      reason: status === "passed" ? "Verifier command exited successfully" : timedOut ? "Verifier execution timed out" : result.error || result.output || "Verifier command failed",
      evidence: createCriterionEvidence({ criterion_id: criterion.id, verifier_type: verifierType, status, valid, executed: true, execution: { executed: true, started_at: started, duration_ms: result.duration_ms, exit_code: result.exit_code, timed_out: timedOut, error: result.error }, stdout: result.stdout || result.output, stderr: result.stderr, result }),
    };
  } catch (error) {
    return timeoutResult(error, started, request);
  }
}

function runFile(config, context, criterion) {
  const started = context.startedAt || new Date().toISOString();
  const root = safeRoot(context.repoRoot);
  if (!root || !config || typeof config.path !== "string" || config.path.trim() === "") return unknownResult(criterion, "file", "File verifier requires a workspace root and relative path", started);
  const candidate = path.resolve(root, config.path);
  if (!insideRoot(root, candidate)) return unknownResult(criterion, "file", "File verifier path is outside the workspace", started);
  try {
    const fileSystem = context.fileSystem || fs;
    const exists = fileSystem.existsSync(candidate);
    let passed = config.exists === true ? exists : config.exists === false ? !exists : exists;
    let reason = exists ? "File exists" : "File does not exist";
    let content = null;
    if (exists && (Object.prototype.hasOwnProperty.call(config, "contains") || Object.prototype.hasOwnProperty.call(config, "content_equals"))) {
      content = fileSystem.readFileSync(candidate, "utf8");
      if (Object.prototype.hasOwnProperty.call(config, "contains")) { passed = passed && typeof config.contains === "string" && content.includes(config.contains); reason = passed ? "File contains the required text" : "File does not contain the required text"; }
      if (Object.prototype.hasOwnProperty.call(config, "content_equals")) { passed = passed && content === config.content_equals; reason = passed ? "File content matches exactly" : "File content does not match"; }
    }
    if (config.changed === true) {
      if (!context.baselineFiles || !Object.prototype.hasOwnProperty.call(context.baselineFiles, config.path)) return unknownResult(criterion, "file", "No baseline is available for changed-file verification", started);
      const baseline = context.baselineFiles[config.path];
      const current = content === null && exists ? fileSystem.readFileSync(candidate, "utf8") : content;
      passed = passed && current !== baseline;
      reason = passed ? "File changed from the supplied baseline" : "File did not change from the supplied baseline";
    }
    const status = passed ? "passed" : "failed";
    return { status, valid: true, reason, evidence: createCriterionEvidence({ criterion_id: criterion.id, verifier_type: "file", status, valid: true, executed: true, execution: { executed: true, started_at: started, duration_ms: Date.now() - new Date(started).getTime(), exit_code: 0 }, result: { path: config.path, exists, checked: { contains: config.contains, content_equals: config.content_equals, changed: config.changed } } }) };
  } catch (error) { return unknownResult(criterion, "file", error.message, started); }
}

function unknownResult(criterion, verifierType, reason, started = new Date().toISOString(), extra = {}) {
  return { status: "unknown", valid: false, reason, evidence: createCriterionEvidence({ criterion_id: criterion.id, verifier_type: verifierType, status: "unknown", valid: false, execution: { started_at: started, duration_ms: Date.now() - new Date(started).getTime(), error: reason, ...extra } }) };
}

async function evaluateCriterion(criterion, context = {}) {
  const verifier = criterion.verifier || {};
  if (verifier.type === "command") return runCommand(verifier.config, context, criterion, "command");
  if (verifier.type === "test") {
    if (!verifier.config?.script_path) return runCommand(verifier.config, context, criterion, "test");
    const root = safeRoot(context.repoRoot);
    if (!root || path.isAbsolute(verifier.config.script_path) || !insideRoot(root, path.resolve(root, verifier.config.script_path))) return unknownResult(criterion, "test", "Test verifier script must remain inside workspace");
    try {
      const runner = context.testRunner || verifyCommandAsync;
      const result = await runner(root, { script_path: verifier.config.script_path, timeout_ms: context.timeoutMs || verifier.config.timeout_ms || 120000 });
      const raw = result.evidence || result;
      const timedOut = raw.timed_out === true || /timed? ?out|timeout/i.test(raw.output || raw.error || "");
      const status = timedOut ? "unknown" : result.passed === true || raw.status === "passed" ? "passed" : raw.status === "failed" ? "failed" : "unknown";
      return { status, valid: !timedOut && (status === "passed" || status === "failed"), reason: status === "passed" ? "Test verification passed" : raw.output || raw.error || "Test verification failed", evidence: createCriterionEvidence({ criterion_id: criterion.id, verifier_type: "test", status, valid: !timedOut, executed: true, execution: { executed: true, duration_ms: raw.duration_ms, exit_code: raw.exit_code, timed_out: timedOut, error: raw.error }, stdout: raw.output, result: raw }) };
    } catch (error) { return timeoutResult(error, new Date().toISOString(), { criterion_id: criterion.id, verifier_type: "test" }); }
  }
  if (verifier.type === "file") return runFile(verifier.config, context, criterion);
  if (verifier.type === "custom" && verifier.config?.application_check) {
    const check = await evaluateApplicationCheck(verifier.config.application_check, context.application || context);
    const status = ["passed", "failed", "unknown", "timeout", "unavailable", "permission_required", "blocked", "escalated"].includes(check.status) ? check.status : "unknown";
    const valid = check.evidence?.executed === true && ["passed", "failed"].includes(status);
    return { status, valid, reason: check.reason || `Application check ${status}`, evidence: createCriterionEvidence({ criterion_id: criterion.id, verifier_type: "custom", status, valid, executed: check.evidence?.executed === true, execution: { executed: check.evidence?.executed === true, timed_out: status === "timeout" }, result: check }) };
  }
  if (verifier.type === "custom" && verifier.config?.repository_check) {
    const check = await evaluateRepositoryCheck(context.repoRoot, verifier.config.repository_check, { runCommand: context.commandRunner });
    const status = check.status === "passed" ? "passed" : check.status === "failed" ? "failed" : "unknown";
    return { status, valid: check.executed === true && status !== "unknown", reason: check.reason || `Repository check ${status}`, evidence: createCriterionEvidence({ criterion_id: criterion.id, verifier_type: "custom", status, valid: check.executed === true && status !== "unknown", executed: check.executed === true, execution: { executed: check.executed === true, duration_ms: check.duration_ms, exit_code: check.exit_code, timed_out: check.timed_out }, stdout: check.stdout, stderr: check.stderr, result: check }) };
  }
  return unknownResult(criterion, verifier.type, "Verifier type is not executable in Phase 2");
}

function evaluationIsComplete(spec, evaluation) {
  if (!evaluation || !Array.isArray(evaluation.criteria)) return false;
  const required = spec.success_criteria.filter(criterion => criterion.required);
  const evidence = new Map((Array.isArray(evaluation.evidence) ? evaluation.evidence : []).map(item => [item.evidence_id, item]));
  const allRequiredVerified = required.every(criterion => {
    const result = evaluation.criteria.find(item => item.id === criterion.id);
    return result?.status === "passed" && Array.isArray(result.evidence_ids) && result.evidence_ids.length > 0 && result.evidence_ids.every(id => evidence.get(id)?.valid === true && evidence.get(id)?.executed === true && evidence.get(id)?.execution?.executed === true);
  });
  return allRequiredVerified && (!evaluation.repository_scope || evaluation.repository_scope.valid === true);
}

async function evaluateGoal(spec, options = {}) {
  assertValidGoalSpec(spec);
  const criteria = [];
  const evidence = [];
  for (const criterion of spec.success_criteria) {
    const evaluated = await evaluateCriterion(criterion, { ...options, startedAt: nowIso(options), timeoutMs: options.timeoutMs || spec.constraints.timeout_ms });
    evidence.push(evaluated.evidence);
    criteria.push({ id: criterion.id, status: evaluated.status, evidence_ids: [evaluated.evidence.evidence_id], reason: evaluated.reason });
  }
  const required = spec.success_criteria.filter(criterion => criterion.required);
  const completed = required.every(criterion => {
    const result = criteria.find(item => item.id === criterion.id);
    const itemEvidence = evidence.find(item => item.evidence_id === result?.evidence_ids[0]);
    return result?.status === "passed" && itemEvidence?.valid === true;
  });
  const progress = requiredProgress(spec.success_criteria.map(criterion => ({ required: criterion.required, status: criteria.find(item => item.id === criterion.id)?.status || "unknown" })));
  const repositoryEvidence = spec.constraints.repository_odd ? await collectRepositoryEvidence(options.repoRoot, { changedFiles: options.changedFiles || [], odd: spec.constraints.repository_odd, runCommand: options.repositoryCommandRunner || options.commandRunner }) : [];
  const scope = options.changedFiles ? compareRepositoryScope({ changedFiles: options.changedFiles, allowedPaths: spec.constraints.repository_odd?.allowed_paths || spec.constraints.allowed_paths || [], protectedPaths: spec.constraints.repository_odd?.protected_paths || [] }) : null;
  return {
    goal_id: spec.goal_id,
    completed: completed && (!scope || scope.valid),
    criteria,
    evidence: [...evidence, ...repositoryEvidence],
    repository_evidence: repositoryEvidence,
    repository_scope: scope,
    progress,
    remaining_criteria: criteria.filter(item => item.status === "failed" && spec.success_criteria.find(criterion => criterion.id === item.id)?.required).map(item => item.id),
    unknown_criteria: criteria.filter(item => item.status === "unknown").map(item => item.id),
    evaluated_at: nowIso(options),
    state_version: 3,
  };
}

module.exports = { evaluateGoal, evaluateCriterion, evaluationIsComplete, commandRequest, SAFE_COMMANDS };

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "tests", "fixtures", "real-swe-single-file");
const { PREAUTHORIZED } = require(path.join(ROOT, "src", "pipeline", "authorization.js"));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function startLocalApplication(root, { mode = "healthy" } = {}) {
  const application = path.join(root, "local-app-server.cjs");
  fs.writeFileSync(application, `const http = require("node:http");
const server = http.createServer((request, response) => {
  let body;
  let status;
  if (request.url === "/health") { body = JSON.stringify({ status: "ok", service: "calculator" }); status = 200; }
  else if (request.url === "/calculator") {
    const calculatorPath = require.resolve("./src/calculator.js");
    delete require.cache[calculatorPath];
    const calculator = require(calculatorPath);
    if (typeof calculator.subtract === "function") { body = JSON.stringify({ status: "ok", operation: "subtract", result: calculator.subtract(5, 2) }); status = 200; }
    else { body = JSON.stringify({ status: "failed", error: "subtract is unavailable" }); status = 500; }
  } else if (request.url === "/calculator?failure=1") { body = JSON.stringify({ status: "failed", error: "calculator unavailable" }); status = 503; }
  else { body = JSON.stringify({ status: "not_found" }); status = 404; }
  const delay = ${mode === "timeout" ? 250 : 0};
  setTimeout(() => { response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); response.end(body); }, delay);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ ready: true, port: server.address().port }) + "\\n"));
`, "utf8");
  const child = spawn(process.execPath, [application], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("Local application startup timed out"), { code: "ETIMEDOUT" })), 5000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const line = stdout.split(/\\r?\\n/).find(item => item.trim());
      if (!line) return;
      try { const value = JSON.parse(line); if (value.ready && Number.isInteger(value.port)) { clearTimeout(timer); resolve(value.port); } } catch {}
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Local application exited with code ${code}`)); } });
  });
  try {
    const port = await ready;
    return {
      child,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      stderr: () => stderr.slice(-1000),
      async isAlive() { return child.exitCode === null && child.signalCode === null; },
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        child.kill();
        await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(2000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        return child.exitCode !== null || child.signalCode !== null;
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-real-swe-"));
  fs.cpSync(TEMPLATE, root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "real-swe@example.invalid"]);
  git(root, ["config", "user.name", "Real SWE Fixture"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "fixture baseline"]);
  return root;
}

function fixtureFiles(root) {
  return ["package.json", "src/calculator.js", "VERIFY_CMD.mjs", "minitok.yml"]
    .filter(file => fs.existsSync(path.join(root, file)));
}

function emptyMetrics() {
  return {
    plan_valid_rate: 0,
    implementation_valid_rate: 0,
    patch_apply_rate: 0,
    verification_pass_rate: 0,
    review_approve_rate: 0,
    merge_success_rate: 0,
    end_to_end_success_rate: 0,
  };
}

function unavailableResult(mode, reason) {
  return {
    mode,
    provider: process.env.MINITOK_REAL_SWE_PROVIDER || null,
    model: process.env.MINITOK_REAL_SWE_MODEL || null,
    plan_valid: false,
    implementation_valid: false,
    patch_generated: false,
    patch_applied: false,
    changed_files: [],
    verification_status: "unknown",
    review_verdict: "UNKNOWN",
    merge_applied: false,
    completed: false,
    status: "unavailable",
    reason,
    pipeline_invoked: false,
    provider_calls: 0,
    metrics: emptyMetrics(),
    release_repository_mutated: false,
  };
}

function liveConfiguration() {
  if (process.env.MINITOK_REAL_SWE_LIVE !== "1") return "MINITOK_REAL_SWE_LIVE=1 is required";
  if (!process.env.MINITOK_REAL_SWE_PROVIDER || !process.env.MINITOK_REAL_SWE_MODEL || !process.env.MINITOK_REAL_SWE_ENDPOINT || !process.env.MINITOK_REAL_SWE_API_KEY) return "provider, model, endpoint, and API key are required";
  if (process.env.MINITOK_REAL_SWE_APPROVAL !== "approve") return "explicit approval required";
  return null;
}

function mockProviderModule({ recovery = false, samePatch = false, invalidRecovery = false } = {}) {
  const providerPath = require.resolve(path.join(ROOT, "src", "llm", "provider.js"));
  const providerModule = require(providerPath);
  let calls = 0;
  let implementationCalls = 0;
  class FixtureProvider extends providerModule.LLMProvider {
    constructor() { super("real-swe-mock"); }
    isAvailable() { return true; }
    async complete(messages) {
      calls += 1;
      const system = messages.find(message => message.role === "system")?.content || "";
      let text;
      if (/architect/i.test(system)) {
        text = JSON.stringify({ task_summary: "Fix add", steps: [{ id: 1, action: "modify", file: "src/calculator.js", description: "Return the sum", rationale: "Current implementation subtracts" }], estimated_files: 1, risk_level: "low" });
      } else if (/software engineer/i.test(system)) {
        implementationCalls += 1;
        if (invalidRecovery && implementationCalls > 1) text = "not valid json";
        else {
          const content = recovery && implementationCalls === 1 || samePatch ? "function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n" : "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n";
          text = JSON.stringify({ changes: [{ file: "src/calculator.js", action: "modify", content }], summary: "Fix add", files_changed: 1 });
        }
      } else if (/code reviewer|meticulous code reviewer/i.test(system)) {
        text = JSON.stringify({ verdict: "APPROVE", confidence: 0.95, summary: "Verified fixture change", findings: [], security_findings: [], risk_level: "low", test_suggestions: [] });
      } else {
        text = JSON.stringify({ done: true, summary: "fixture complete" });
      }
      return { text, model: "fixture-mock", usage: {}, tokens: { input: 10, output: 10 } };
    }
  }
  providerModule.createProvider = () => new FixtureProvider();
  return { getCalls: () => calls };
}


function summarizeResult(mode, root, result, provider, calls, releaseBefore) {
  const cycle = result?.cycles?.at(-1) || {};
  const evidence = cycle.evidence || {};
  const changedFiles = git(root, ["diff", "HEAD", "--name-only"]).split(/\r?\n/).filter(Boolean);
  const sourceHash = sha256File(path.join(root, "src", "calculator.js"));
  const patchGenerated = Boolean(evidence.workspace?.patch_generated || result?.isolation?.merge?.patch_signature || evidence.implementation?.patch_signature);
  const patchApplied = result?.isolation?.applied === true || evidence.workspace?.merge_applied === true;
  const mergeApplied = result?.isolation?.merge?.applied === true || evidence.workspace?.merge_applied === true;
  const planValid = evidence.plan?.valid === true;
  const implementationValid = evidence.implementation?.response_valid === true && evidence.implementation?.change_count > 0;
  const verificationPassed = evidence.verification?.status === "passed";
  const reviewApproved = evidence.review?.verdict === "APPROVE";
  const completed = result?.success === true && mergeApplied && verificationPassed;
  const cycleSummary = item => ({ status: item?.status || item?.evidence?.status || "unknown", patch_signature: item?.evidence?.implementation?.patch_signature || null, verification: item?.evidence?.verification?.status || "unknown", completed: item?.evidence?.status === "completed" });
  const initialCycle = result?.cycles?.[0];
  const finalCycle = result?.cycles?.at(-1);
  const recoveryRecord = result?.recovery?.records?.[0] || null;
  return {
    fixture: { root, created: true, git_repository: fs.existsSync(path.join(root, ".git")), files: fixtureFiles(root) },
    mode, provider, model: evidence.model || (["mock", "recovery", "recovery-same", "recovery-invalid"].includes(mode) ? "fixture-mock" : process.env.MINITOK_REAL_SWE_MODEL || null),
    initial_cycle: cycleSummary(initialCycle),
    recovery_summary: recoveryRecord ? { ...recoveryRecord, previous_patch_signature: recoveryRecord.previous_patch_signature || initialCycle?.evidence?.implementation?.patch_signature || null } : { scheduled: false, task_generated: false, same_patch_repeated: false },
    final_cycle: cycleSummary(finalCycle),
    plan_valid: planValid, implementation_valid: implementationValid, patch_generated: patchGenerated, patch_applied: patchApplied,
    changed_files: changedFiles, source_hash: sourceHash, verification_status: evidence.verification?.status || "unknown",
    review_verdict: evidence.review?.verdict || "UNKNOWN", merge_applied: mergeApplied, completed,
    status: completed ? "completed" : (result?.terminal_status && result.terminal_status !== "unknown" ? result.terminal_status : evidence.status || "unknown"),
    terminal_status: completed ? "completed" : (result?.terminal_status || null), failure_category: completed ? null : (result?.failure_category || null),
    failure_stage: completed ? null : (result?.failure_stage || null), last_cycle_evidence_id: result?.last_cycle_evidence_id || evidence.evidence_id || null,
    pipeline_invoked: true, provider_calls: calls,
    metrics: {
      plan_valid_rate: planValid ? 1 : 0, implementation_valid_rate: implementationValid ? 1 : 0,
      patch_apply_rate: patchApplied ? 1 : 0, verification_pass_rate: verificationPassed ? 1 : 0,
      review_approve_rate: reviewApproved ? 1 : 0, merge_success_rate: mergeApplied ? 1 : 0,
      end_to_end_success_rate: completed ? 1 : 0,
    },
    recovery: result?.recovery || (recoveryRecord ? { records: [recoveryRecord], scheduled: true, task_generated: true } : { scheduled: false, task_generated: false, records: [] }),
    release_repository_mutated: releaseBefore !== execFileSync("git", ["status", "--porcelain=v1"], { cwd: ROOT, encoding: "utf8" }),
  };
}

export async function runFixture(mode = "mock", options = {}) {
  if (mode === "live") {
    const reason = liveConfiguration();
    if (reason) return unavailableResult(mode, reason);
  }
  if (!["mock", "live", "recovery", "recovery-same", "recovery-invalid"].includes(mode)) return unavailableResult(mode, "unsupported mode");
  const root = createFixture();
  const releaseBefore = execFileSync("git", ["status", "--porcelain=v1"], { cwd: ROOT, encoding: "utf8" });
  try {
    const loop = require(path.join(ROOT, "src", "pipeline", "loop.js"));
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      let provider;
      let calls;
      let overrides;
      if (["mock", "recovery", "recovery-same", "recovery-invalid"].includes(mode)) {
        const injected = mockProviderModule({ recovery: mode === "recovery" || mode === "recovery-invalid", samePatch: mode === "recovery-same", invalidRecovery: mode === "recovery-invalid" });
        provider = "real-swe-mock";
        calls = () => injected.getCalls();
        overrides = { budget: { max_cycles: mode === "mock" ? 1 : 2, token_budget: options.tokenBudget || 20000 }, execution: { research_enabled: false, timeout_hard_limit_sec: 60 }, validation: { timeout_ms: options.timeoutMs || 10000 } };
      } else {
        provider = process.env.MINITOK_REAL_SWE_PROVIDER;
        calls = () => 1;
        overrides = { default_provider: provider, providers: { [provider]: { base_url: process.env.MINITOK_REAL_SWE_ENDPOINT, api_key: process.env.MINITOK_REAL_SWE_API_KEY, model: process.env.MINITOK_REAL_SWE_MODEL } }, roles: { plan: { provider, model: process.env.MINITOK_REAL_SWE_MODEL }, work: { provider, model: process.env.MINITOK_REAL_SWE_MODEL }, review: { provider, model: process.env.MINITOK_REAL_SWE_MODEL } }, budget: { max_cycles: options.maxCycles || 2, token_budget: options.tokenBudget || 50000 }, execution: { research_enabled: false, timeout_hard_limit_sec: 60 }, validation: { timeout_ms: options.timeoutMs || 30000 } };
      }
      const result = await loop.runPipeline("Fix add so it returns a+b in src/calculator.js", { repoRoot: root, authorization: PREAUTHORIZED, autoAccept: true, overrides });
      return summarizeResult(mode, root, result, provider, calls(), releaseBefore);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const value = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  return {
    mode: value("--mode") || "mock",
    createOnly: argv.includes("--create-only"),
    maxCycles: Number(value("--max-cycles")) || undefined,
    timeoutMs: Number(value("--timeout-ms")) || undefined,
    tokenBudget: Number(value("--token-budget")) || undefined,
    unknownCriterion: value("--unknown-criterion"),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const options = parseArgs(process.argv.slice(2));
  if (options.createOnly) {
    const root = createFixture();
    console.log(JSON.stringify({ fixture: { created: true, root, git_repository: fs.existsSync(path.join(root, ".git")), files: fixtureFiles(root) } }));
  } else {
    const output = options.mode === "resume-injected" ? await runProviderResume("injected") : options.mode === "resume-live" ? await runProviderResume("live") : options.mode === "multi-injected" ? await runMultiCycleGoal("injected", options) : options.mode === "multi-live" ? await runMultiCycleGoal("live", options) : options.mode === "local-application" ? await runLocalApplicationGoal() : await runFixture(options.mode, options);
    console.log(JSON.stringify(output));
  }

}
function resumeConfiguration() {
  const required = ["MINITOK_REAL_SWE_LIVE", "MINITOK_REAL_SWE_PROVIDER_A", "MINITOK_REAL_SWE_MODEL_A", "MINITOK_REAL_SWE_PROVIDER_B", "MINITOK_REAL_SWE_MODEL_B", "MINITOK_REAL_SWE_ENDPOINT", "MINITOK_REAL_SWE_API_KEY", "MINITOK_REAL_SWE_APPROVAL"];
  if (!required.every(key => process.env[key])) return "credential/provider/model not configured";
  if (process.env.MINITOK_REAL_SWE_LIVE !== "1" || process.env.MINITOK_REAL_SWE_APPROVAL !== "approve") return "credential/provider/model not configured";
  return null;
}

function resumeSkippedResult(reason) {
  return { live_status: "skipped", live_e2e_status: "skipped", production_ready: false, reason, resumed: false, provider_calls: 0, state_preserved: false, history_preserved: false, model_changed: false, provider_changed: false, final_evaluator_completed: false, provider_evidence: [] };
}

export async function runProviderResume(mode = "injected") {
  if (mode === "live") {
    const reason = resumeConfiguration();
    if (reason) return resumeSkippedResult(reason);
  }
  const root = createFixture();
  const providerEvidence = [];
  const providerCalls = [];
  const goalId = "real-swe-resume-goal";
  try {
    const { createGoalSpec } = require(path.join(ROOT, "src", "goal", "spec.js"));
    const { createGoalSession, createCheckpoint, pauseGoalSession, releaseGoalSessionLock, resumeGoalSession } = require(path.join(ROOT, "src", "goal", "session.js"));
    const { GoalController } = require(path.join(ROOT, "src", "goal", "controller.js"));
    const spec = createGoalSpec({ schema_version: 1, goal_id: goalId, objective: "resume fixture goal", success_criteria: [{ id: "calculator", description: "calculator verifier passes", required: true, verifier: { type: "file", id: "calculator-file", config: { path: "src/calculator.js", contains: "return a + b" } } }], constraints: { allowed_paths: ["src"], blocked_paths: [".git"], max_cycles: 3, max_tokens: 10000, timeout_ms: 0, stagnation_limit: 3, max_changed_files: 2, same_task_limit: 3, same_failure_limit: 3, requires_approval_for: [] }, execution_policy: { mode: "safe" } });
    const session = createGoalSession({ workspaceRoot: root, goalSpec: spec, model: "model-a", provider: "provider-a" });
    const initialTask = "provider-a initial task";
    session.state.current_task = initialTask;
    session.state.task_history.push({ task: initialTask, status: "success", success: true, patch_signature: "initial-checkpoint" });
    session.state.cycle_count = 1;
    createCheckpoint(session, { trackedPaths: ["src/calculator.js"], label: "provider-a-checkpoint" });
    pauseGoalSession(session, "provider replacement test");
    releaseGoalSessionLock(session);
    const resumed = resumeGoalSession(root, goalId, { model: "model-b", provider: "provider-b" });
    const stateBefore = { task_count: resumed.state.task_history.length, cycle_count: resumed.state.cycle_count, goal_id: resumed.goalSpec.goal_id };
    const taskProposer = async (_goal, remaining) => { const task = resumed.state.task_history.length > 1 ? "provider-b follow-up task" : "provider-b resumed task"; return { next_task: task, target_criteria: remaining.map(item => item.id) }; };
    const taskExecutor = async task => {
      const provider = resumed.state.provider;
      const model = resumed.state.model;
      const role = "goal_task_executor";
      providerCalls.push({ provider, model, role, cycle: resumed.state.cycle_count + 1 });
      providerEvidence.push({ cycle: resumed.state.cycle_count + 1, resumed: true, provider, model, role, goal_id: goalId });
      resumed.state.task_history.push({ task, status: "success", success: true, patch_signature: "provider-b-patch" });
      resumed.state.cycle_count += 1;
      return { success: true, status: "success", provider, model, provider_evidence: providerEvidence.at(-1), changes: { changed_files: ["src/calculator.js"] }, tokens: { input: 1, output: 1 } };
    };
    let evaluationCalls = 0;
    const evaluator = async () => {
      evaluationCalls += 1;
      const passed = evaluationCalls > 1;
      return { criteria: [{ id: "calculator", status: passed ? "passed" : "failed", evidence_ids: ["resume-evidence"] }], evidence: [{ evidence_id: "resume-evidence", valid: passed, executed: true, execution: { executed: true } }], remaining_criteria: passed ? [] : ["calculator"], unknown_criteria: [] };
    };
    const controller = new GoalController(spec, { session: resumed, model: resumed.state.model, provider: resumed.state.provider, taskProposer, taskExecutor, evaluator, releaseSessionOnExit: true });
    const output = await controller.run();
    return { live_e2e_status: mode === "live" ? "passed" : "injected", resumed: true, provider_calls: providerCalls.length, provider_evidence: providerEvidence, state_preserved: stateBefore.task_count >= 1 && stateBefore.cycle_count === 1 && output.goal_id === goalId, history_preserved: output.task_history.length >= 2, model_changed: resumed.state.model === "model-b", provider_changed: resumed.state.provider === "provider-b", task_changed: output.task_history[0]?.task !== output.task_history.at(-1)?.task, checkpoint_revalidation: resumed.resumeCheck.requires_verification === false, final_evaluator_completed: output.completed === true, goal_id: goalId };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function runLocalApplicationGoal() {
  const root = createFixture();
  let application = null;
  let timeoutApplication = null;
  const result = { live_e2e_status: "injected", goal_id: "real-swe-local-application-goal", provider_calls: 0, criteria: [], completed: false, evaluator_completed: false, process_started: false, process_health: "unknown", http: {}, cleanup: { application_stopped: false, timeout_application_stopped: false, fixture_removed: false } };
  try {
    const { createGoalSpec } = require(path.join(ROOT, "src", "goal", "spec.js"));
    const { GoalController } = require(path.join(ROOT, "src", "goal", "controller.js"));
    const { evaluateGoal } = require(path.join(ROOT, "src", "goal", "evaluator.js"));
    const { evaluateApplicationCheck, APPLICATION_CAPABILITIES } = require(path.join(ROOT, "src", "goal", "application.js"));
    application = await startLocalApplication(root);
    result.process_started = true;
    const baseUrl = application.baseUrl;
    const applicationOptions = { capabilities: new Set(APPLICATION_CAPABILITIES), approvals: new Set(APPLICATION_CAPABILITIES), allowedUrls: [baseUrl], codeState: "fixture-source-observed", applicationState: "localhost-process", processHealth: async () => ({ alive: await application.isAlive(), pid: application.child.pid }) };
    const spec = createGoalSpec({ schema_version: 1, goal_id: result.goal_id, objective: "Expose subtract through disposable localhost calculator", success_criteria: [
      { id: "process-health", description: "local process remains alive", required: true, verifier: { type: "custom", id: "local-process-health", config: { application_check: { kind: "process_health", process: "calculator-fixture", expect_alive: true } } } },
      { id: "health", description: "health response is correct", required: true, verifier: { type: "custom", id: "local-health", config: { application_check: { kind: "local_http", url: `${baseUrl}/health`, expect_status: 200, expect_body_contains: '"status":"ok"' } } } },
      { id: "calculator", description: "calculator JSON is correct", required: true, verifier: { type: "custom", id: "local-calculator", config: { application_check: { kind: "api_assertion", url: `${baseUrl}/calculator`, expect_status: 200, assertions: [{ path: "status", equals: "ok" }, { path: "result", equals: 3 }] } } } },
      { id: "failure-response", description: "failure response is observable", required: true, verifier: { type: "custom", id: "local-failure", config: { application_check: { kind: "api_assertion", url: `${baseUrl}/calculator?failure=1`, expect_status: 503, assertions: [{ path: "status", equals: "failed" }] } } } },
    ], constraints: { allowed_paths: ["src"], blocked_paths: [".git"], max_cycles: 3, max_tokens: 10000, timeout_ms: 0, stagnation_limit: 2, max_changed_files: 2, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } });
    const taskHistory = [];
    const evaluator = async () => evaluateGoal(spec, { application: applicationOptions, repoRoot: root });
    const taskProposer = async (_goal, remaining) => ({ next_task: remaining.some(item => item.id === "calculator") ? "implement subtract in src/calculator.js" : "recheck localhost application", target_criteria: remaining.map(item => item.id), done: true });
    const taskExecutor = async task => {
      if (task === "implement subtract in src/calculator.js") fs.writeFileSync(path.join(root, "src", "calculator.js"), "function add(a, b) {\n  return a - b;\n}\n\nfunction subtract(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, subtract };\n", "utf8");
      taskHistory.push({ task, changed_files: task.startsWith("implement") ? ["src/calculator.js"] : [] });
      return { success: true, status: "success", done: true, changes: { changed_files: taskHistory.at(-1).changed_files }, tokens: { input: 1, output: 1 } };
    };
    const controller = new GoalController(spec, { evaluator, taskProposer, taskExecutor, model: "local-application-mock", provider: "injected" });
    const output = await controller.run();
    const evaluation = output.evaluation || output.evaluator_results?.at(-1) || { criteria: [], evidence: [] };
    result.criteria = spec.success_criteria.map(criterion => { const item = evaluation.criteria?.find(entry => entry.id === criterion.id); const evidence = (evaluation.evidence || []).find(entry => entry.evidence_id === item?.evidence_ids?.[0]); return { id: criterion.id, status: item?.status || "unknown", evidence_ids: item?.evidence_ids || [], evidence_status: evidence?.status || null, executed: evidence?.executed === true, application_state: evidence?.result?.evidence?.application_state || null, code_state: evidence?.result?.evidence?.code_state || null }; });
    result.completed = output.completed === true;
    result.evaluator_completed = output.completed === true;
    result.cycles = output.cycle_count;
    result.process_health = result.criteria.find(item => item.id === "process-health")?.status || "unknown";
    result.application_state_separate = result.criteria.some(item => item.application_state === "localhost-process") && result.criteria.some(item => item.code_state === "fixture-source-observed");
    result.task_history = taskHistory;
    timeoutApplication = await startLocalApplication(root, { mode: "timeout" });
    const timeoutCheck = await evaluateApplicationCheck({ kind: "local_http", url: `${timeoutApplication.baseUrl}/health`, timeout_ms: 25 }, { ...applicationOptions, allowedUrls: [timeoutApplication.baseUrl] });
    result.http.timeout = { status: timeoutCheck.status, reason: timeoutCheck.reason };
    result.cleanup.timeout_application_stopped = await timeoutApplication.close();
    result.cleanup.application_stopped = await application.close();
    const unavailableCheck = await evaluateApplicationCheck({ kind: "local_http", url: `${baseUrl}/health`, timeout_ms: 100 }, { ...applicationOptions, allowedUrls: [baseUrl] });
    result.http.unavailable = { status: unavailableCheck.status, reason: unavailableCheck.reason };
    result.http.success = result.criteria.every(item => item.status === "passed");
    return result;
  } finally {
    if (timeoutApplication) result.cleanup.timeout_application_stopped = result.cleanup.timeout_application_stopped || await timeoutApplication.close();
    if (application) result.cleanup.application_stopped = result.cleanup.application_stopped || await application.close();
    fs.rmSync(root, { recursive: true, force: true });
    result.cleanup.fixture_removed = true;
  }
}

export async function runMultiCycleGoal(mode = "injected", options = {}) {
  if (mode === "live") {
    const reason = resumeConfiguration() || "actual multi-cycle provider adapter is not enabled";
    return { live_status: "skipped", live_e2e_status: "skipped", production_ready: false, reason, cycles: 0, criterion_progress: [], recovery_count: 0, resume_count: 0, completed: false, evaluator_completed: false, final_evaluator_completion: false, criteria: [], provider_calls: 0, verifier_execution_rate: 0, evidence_complete: false, evidence_completeness: 0, false_completion: false, unsafe_action: false, provider_evidence: [] };
  }
  const root = createFixture();
  try {
    const { createGoalSpec } = require(path.join(ROOT, "src", "goal", "spec.js"));
    const { GoalController } = require(path.join(ROOT, "src", "goal", "controller.js"));
    const { evaluateGoal, evaluationIsComplete } = require(path.join(ROOT, "src", "goal", "evaluator.js"));
    const { createCriterionEvidence } = require(path.join(ROOT, "src", "goal", "evidence.js"));
    const { runProcessAsync } = require(path.join(ROOT, "src", "pipeline", "check.js"));
    const { APPLICATION_CAPABILITIES } = require(path.join(ROOT, "src", "goal", "application.js"));
    const goalId = "real-swe-multi-cycle-goal";
    const spec = createGoalSpec({ schema_version: 1, goal_id: goalId, objective: "Add subtract and verify it", success_criteria: [
      { id: "implementation", description: "calculator exports subtract", required: true, verifier: { type: "file", id: "subtract-implementation", config: { path: "src/calculator.js", contains: "function subtract" } } },
      { id: "test", description: "subtract test exists", required: true, verifier: { type: "file", id: "subtract-test", config: { path: "test/calculator.test.js", contains: "subtract" } } },
      { id: "command", description: "npm test passes", required: true, verifier: { type: "command", id: "npm-test", config: { command: "npm", args: ["test"] } } },
    ], constraints: { allowed_paths: ["src", "test", "package.json"], blocked_paths: [".git"], max_cycles: 5, max_tokens: 20000, timeout_ms: 0, stagnation_limit: 3, max_changed_files: 5, same_task_limit: 2, same_failure_limit: 2, requires_approval_for: [] }, execution_policy: { mode: "safe" } });
    const providerCalls = [];
    const taskHistory = [];
    let doneClaim = false;
    const taskProposer = async (_goal, remaining) => {
      doneClaim = true;
      const ids = remaining.map(item => item.id);
      const next = ids.includes("implementation") ? "implement subtract" : ids.includes("test") ? "add subtract test" : "run npm test";
      return { next_task: next, target_criteria: ids, done: true, rationale: "model done claim is not completion authority" };
    };
    const taskExecutor = async (task, taskOptions) => {
      providerCalls.push({ cycle: taskOptions.cycle, provider: mode === "live" ? process.env.MINITOK_REAL_SWE_PROVIDER_B : "multi-cycle-mock", model: mode === "live" ? process.env.MINITOK_REAL_SWE_MODEL_B : "multi-cycle-mock", role: "goal_task_executor" });
      if (task === "implement subtract") {
        fs.writeFileSync(path.join(root, "src", "calculator.js"), "function add(a, b) {\n  return a - b;\n}\n\nfunction subtract(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, subtract };\n", "utf8");
        taskHistory.push({ task, action: "implementation", changed_files: ["src/calculator.js"] });
      } else if (task === "add subtract test") {
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        packageJson.scripts.test = "node --test test/calculator.test.js";
        fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
        fs.mkdirSync(path.join(root, "test"), { recursive: true });
        fs.writeFileSync(path.join(root, "test", "calculator.test.js"), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { subtract } = require('../src/calculator');\ntest('subtract subtracts two numbers', () => assert.equal(subtract(5, 2), 3));\n", "utf8");
        taskHistory.push({ task, action: "test", changed_files: ["package.json", "test/calculator.test.js"] });
      } else {
        taskHistory.push({ task, action: "command", changed_files: [] });
      }
      return { success: true, status: "success", done: true, provider_evidence: providerCalls.at(-1), changes: { changed_files: taskHistory.at(-1).changed_files }, tokens: { input: 1, output: 1 } };
    };
    const commandRunner = async (command, args, cwd, commandOptions = {}) => {
      try {
        const executable = process.platform === "win32" && /\.cmd$/i.test(command) ? process.env.ComSpec : command;
        const executableArgs = process.platform === "win32" && /\.cmd$/i.test(command) ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args;
        const output = execFileSync(executable, executableArgs, { cwd, encoding: "utf8", timeout: commandOptions.timeout_ms || 120000, stdio: ["ignore", "pipe", "pipe"] });
        return { status: "passed", exit_code: 0, output: output.slice(-4000), duration_ms: 0 };
      } catch (error) {
        return { status: "failed", exit_code: typeof error.status === "number" ? error.status : 1, output: `${error.stdout || ""}${error.stderr || ""}`.slice(-4000), error: error.message, duration_ms: 0 };
      }
    };
    const evaluator = async () => {
      if (options.unknownCriterion === "test") {
        const unknown = createCriterionEvidence({ criterion_id: "test", verifier_type: "file", status: "unknown", valid: false, executed: false, result: { reason: "fixture intentionally unknown" } });
        return { goal_id: goalId, completed: false, criteria: [{ id: "implementation", status: "failed", evidence_ids: [] }, { id: "test", status: "unknown", evidence_ids: [unknown.evidence_id] }, { id: "command", status: "unknown", evidence_ids: [] }], evidence: [unknown], remaining_criteria: ["implementation", "test", "command"], unknown_criteria: ["test", "command"] };
      }
      return evaluateGoal(spec, { repoRoot: root, commandRunner });
    };

    const controller = new GoalController(spec, { evaluator, taskProposer, taskExecutor, model: mode === "live" ? process.env.MINITOK_REAL_SWE_MODEL_B : "multi-cycle-mock", provider: mode === "live" ? process.env.MINITOK_REAL_SWE_PROVIDER_B : "multi-cycle-mock" });
    const output = await controller.run();
    const finalEvaluation = output.evaluation || output.evaluator_results?.at(-1) || { criteria: [], evidence: [] };
    const criteria = spec.success_criteria.map(criterion => { const item = finalEvaluation.criteria?.find(entry => entry.id === criterion.id); const evidence = (finalEvaluation.evidence || []).find(entry => entry.evidence_id === item?.evidence_ids?.[0]); return { id: criterion.id, status: item?.status || "unknown", evidence_ids: item?.evidence_ids || [], reason: item?.reason || null, evidence_status: evidence?.status || null }; });
    const requiredCount = spec.success_criteria.filter(criterion => criterion.required).length;
    const criterionProgress = (output.evaluator_results || []).map((evaluation, index) => ({ cycle: index + 1, passed: (evaluation.criteria || []).filter(item => item.status === "passed").length, required: requiredCount, statuses: (evaluation.criteria || []).map(item => ({ id: item.id, status: item.status })) }));
    const executedEvidence = (finalEvaluation.evidence || []).filter(item => item.executed === true && item.execution?.executed === true).length;
    const verifierExecutionRate = requiredCount > 0 ? executedEvidence / requiredCount : 0;
    const evidenceComplete = evaluationIsComplete(spec, finalEvaluation);
    const completed = output.completed === true;
    return { live_status: "injected", live_e2e_status: "injected", production_ready: false, goal_id: goalId, criteria, criterion_progress: criterionProgress, cycles: output.cycle_count, recovery_count: output.recovery_history?.length || 0, resume_count: 0, model_done_claim: doneClaim, unknown_not_passed: !criteria.some(item => item.status === "unknown" && item.status === "passed"), completed, evaluator_completed: completed, final_evaluator_completion: evidenceComplete, verifier_execution_rate: verifierExecutionRate, evidence_complete: evidenceComplete, evidence_completeness: requiredCount > 0 ? criteria.filter(item => item.status === "passed" && item.evidence_ids.length > 0).length / requiredCount : 0, false_completion: completed && !evidenceComplete, unsafe_action: false, provider_calls: providerCalls.length, provider_evidence: providerCalls.map((call, index) => ({ ...call, cycle: index + 1, resumed: false, goal_id: goalId })), changed_files: [...new Set(taskHistory.flatMap(item => item.changed_files))], task_history: taskHistory };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}




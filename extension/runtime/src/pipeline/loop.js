"use strict";

/**
 * Autonomous loop — orchestrates plan → implement → verify → iterate.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const providerModule = require("../llm/provider");
const { loadConfig, resolveProviderName } = require("../config/loader");
const { intel } = require("./intel");
const { plan } = require("./planner");
const { implement, applyChanges, DEFAULT_BLOCKED_EXTENSIONS } = require("./implementer");
const { verify } = require("./verifier");
const { verifyCommand } = require("./check");
const { buildRepairTask } = require("./repair");
const { writeContract, writeContextManifest, readContract } = require("../state/contracts");
const { recordRunEvidence } = require("../run-evidence");
const { generateNextTask } = require("./next_task");
const { compactText, DEFAULT_CONTEXT_BUDGET_CHARS } = require("../context/compaction");
const { KnowledgeStore } = require("../evolution/knowledge");
const { analyzeFailurePatterns, FailureAnalyzer } = require("../evolution/analyzer");
const { recommendPolicy, EscalationEngine } = require("../evolution/policy");
const { uploadEvolutionOutcome } = require("../evolution/upload");
const { authorizeEntitlement } = require("../entitlement/policy");
const { ALLOWED_FIELDS } = require("../evolution/sanitize");
const { findEscalationModel } = require("../llm/models");
const { resolveServerUrl } = require("../cli/commands/server-config");
let TEST_AUTHORIZATION = Object.freeze({});
try { ({ TEST_AUTHORIZATION } = require("./test-seam")); } catch {}
const git = require("../git/operations");
const readline = require("readline");
const os = require("os");

const INSTALLATION_TOKEN_FILE = path.join(os.homedir(), ".minitok", "entitlement", "installation-token.json");

/**
 * Read the stored installation token (from minitok activate).
 * @returns {{ token: string, serverUrl: string } | null}
 */
function _loadUploadCredentials() {
  try {
    const data = fs.readFileSync(INSTALLATION_TOKEN_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (!parsed.token || typeof parsed.token !== "string") return null;
    const serverUrl = resolveServerUrl();
    return { token: parsed.token, serverUrl };
  } catch {
    return null;
  }
}

/**
 * Restore the signal listeners that existed before a run.
 *
 * The handlers registered by the caller (both GUIs install SIGINT/SIGTERM
 * handlers before calling into the pipeline) were never removed, so re-adding
 * the snapshot produced a duplicate of every existing handler. Worse, each run
 * snapshotted the duplicates of the previous run, so the listener count doubled
 * per run (2, 4, 8, 16, ...): MaxListenersExceededWarning at the fourth task and
 * every handler running 2^N times on Ctrl+C. Normalize to the original multiset
 * instead of appending.
 */
function restoreSignalListeners(event, original, added) {
  process.removeListener(event, added);
  const pending = new Map();
  for (const handler of original) pending.set(handler, (pending.get(handler) || 0) + 1);
  for (const handler of process.listeners(event)) {
    const remaining = pending.get(handler) || 0;
    if (remaining === 0) process.removeListener(event, handler);
    else pending.set(handler, remaining - 1);
  }
  for (const [handler, missing] of pending) for (let i = 0; i < missing; i += 1) process.on(event, handler);
}

function getRepoContext(repoRoot, maxFiles = 50) {
  const lines = [];
  lines.push(`Repository: ${repoRoot}`);
  lines.push(`Branch: ${git.currentBranch(repoRoot) || "unknown"}`);
  lines.push(`Commit: ${git.headCommit(repoRoot) || "unknown"}`);
  lines.push(`Files: ${git.fileCount(repoRoot)}`);
  const recent = git.logRecent(repoRoot, 5);
  if (recent) lines.push(`Recent:\n${recent}`);

  // Read key files
  const keyFiles = ["package.json", "pyproject.toml", "README.md", "minitok.yml", "Cargo.toml", "go.mod"];
  for (const f of keyFiles) {
    const fp = path.join(repoRoot, f);
    if (fs.existsSync(fp)) {
      try {
        const content = fs.readFileSync(fp, "utf-8").slice(0, 2000);
        lines.push(`\n--- ${f} ---\n${content}`);
      } catch {}
    }
  }
  return lines.join("\n");
}

function compactContext(repoContext, budgetChars) {
  const result = compactText(repoContext, { budget_chars: budgetChars });
  if (result.compacted) {
    console.log(`  📦 Context compacted: ${result.original_chars} → ${result.final_chars} chars`);
  }
  return result.text;
}

function buildRoleOptions(role = {}, signal, timeoutMs) {
  const roleOptions = { model: role.model, signal };
  // A role budget travels with the request so the provider bounds its HTTP call
  // by it instead of the fixed default (see fetchWithTimeout).
  if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) roleOptions.timeout_ms = Number(timeoutMs);
  if (role.reasoning) {
    roleOptions.reasoning_effort = role.reasoning;
    roleOptions.thinking = role.reasoning;
  }
  if (role.thinking !== undefined) roleOptions.thinking = role.thinking;
  if (role.effort) roleOptions.effort = role.effort;
  if (role.thinking_budget) {
    roleOptions.thinking_budget = role.thinking_budget;
    roleOptions.thinking = { enabled: true, budget_tokens: role.thinking_budget };
  }
  return roleOptions;
}

function approvalRequest(changesResult, opts, now = Date.now()) {
  const timeout = Number(opts.approvalTimeoutMs) || 30 * 60 * 1000;
  return {
    type: "approval_request",
    run_id: opts.runId || null,
    nonce: crypto.randomBytes(24).toString("hex"),
    expires_at: now + timeout,
    files: (changesResult.changes || []).map(change => ({ action: change.action, file: change.file, digest: crypto.createHash("sha256").update(JSON.stringify(change)).digest("hex") })),
  };
}

function writeApprovalRequest(file, request) {
  const target = path.resolve(file);
  const temporary = `${target}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  const payload = `${JSON.stringify(request)}\n`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, payload, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function validateApprovalResponse(response, request, now = Date.now()) {
  if (!request || request.type !== "approval_request" || typeof request.nonce !== "string" || (typeof request.run_id !== "string" && request.run_id !== null) || !Number.isFinite(request.expires_at)) return false;
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  if (Object.keys(response).some(key => !["decision", "nonce", "run_id"].includes(key))) return false;
  if (response.decision !== "approve" && response.decision !== "reject") return false;
  if (typeof response.nonce !== "string" || response.nonce !== request.nonce) return false;
  if (response.run_id !== request.run_id) return false;
  if (now >= request.expires_at) return false;
  return true;
}

/**
 * Prompt user for confirmation of file changes.
 * Returns true if accepted, false if rejected.
 */
async function promptConfirmation(changesResult, opts) {
  if (opts.dryRun) return true;

  if (opts.approvalFile) {
    const approvalPath = path.resolve(opts.approvalFile);
    const workspaceRoot = path.resolve(opts.repoRoot || process.cwd());
    const allowedRoot = path.join(workspaceRoot, ".minitok");
    const normalized = process.platform === "win32" ? approvalPath.toLowerCase() : approvalPath;
    const normalizedRoot = process.platform === "win32" ? allowedRoot.toLowerCase() : allowedRoot;
    if (!(normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`))) throw new Error("approval_file must be under workspace/.minitok");
    const responsePath = `${approvalPath}.response`;
    const request = approvalRequest(changesResult, opts);
    fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
    try { fs.rmSync(responsePath, { force: true }); } catch {}
    writeApprovalRequest(approvalPath, request);
    console.log(`MINITOK_APPROVAL_REQUEST ${JSON.stringify(request)}`);
    const deadline = Date.now() + (Number(opts.approvalTimeoutMs) || 30 * 60 * 1000);
    while (Date.now() < deadline) {
      // Honour cancellation. Without this the poll ignored :cancel / run_cancel /
      // SIGINT and kept the run (plus its MCP slot and diverted stdout) alive for
      // the whole timeout — 30 minutes by default.
      if (opts.signal?.aborted) {
        try { fs.rmSync(approvalPath, { force: true }); } catch {}
        return false;
      }
      try {
        const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
        if (!validateApprovalResponse(response, request)) {
          try { fs.rmSync(responsePath, { force: true }); } catch {}
          continue;
        }
        fs.rmSync(responsePath, { force: true });
        fs.rmSync(approvalPath, { force: true });
        return response.decision === "approve";
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    try { fs.rmSync(approvalPath, { force: true }); } catch {}
    return false;
  }

  if (opts.autoAccept === true && opts.allowAutoAccept !== false) return true;

  const changes = changesResult.changes || [];
  if (changes.length === 0) return true;

  if (!process.stdin.isTTY) {
    console.error("No TTY detected. Refusing to accept file changes without --auto-accept.");
    return false;
  }

  // Display changes to user
  console.log("\n📝 Proposed file changes:");
  for (const c of changes) {
    const icon = c.action === "create" ? "➕" : c.action === "delete" ? "🗑️" : "✏️";
    console.log(`   ${icon} ${c.action}: ${c.file}`);
  }
  console.log("");

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question("   Accept these changes? [y/N] ", (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

async function runPipelineInWorkspace(task, opts = {}) {
  const startTime = Date.now();
  let rawRepoContext = null; // P1: computed once (see cycle loop below)
  const repoRoot = opts.repoRoot || process.cwd();
  const configPath = opts.configPath || path.join(repoRoot, "minitok.yml");
  const config = loadConfig(configPath, opts.overrides);
  // execution.research_enabled was accepted, env-mapped and written by `migrate`
  // but never read, so disabling research still ran the intel phase every cycle
  // (paid tokens) and still demanded intel provider credentials.
  const researchEnabled = config.execution?.research_enabled !== false;

  // --coding-adapter / --research-adapter / --review-adapter were parsed by the
  // CLI, forwarded into runPipeline and then never read. They name the role they
  // configure, so map them onto the role adapter (which resolveProviderName
  // consults) and clear the role provider so the flag actually takes effect.
  const adapterOverrides = { work: opts.codingAdapter, intel: opts.researchAdapter, review: opts.reviewAdapter };
  for (const [role, adapter] of Object.entries(adapterOverrides)) {
    if (typeof adapter !== "string" || !adapter.trim()) continue;
    config.roles[role] = { ...config.roles[role], provider: "", adapter: adapter.trim() };
  }

  // security.blocked_extensions is a floor, not a replacement: the built-in list
  // (executables and scripts) may be extended by configuration but never
  // weakened. Before this the option reached no call site at all.
  const configuredBlocked = Array.isArray(config.security?.blocked_extensions) ? config.security.blocked_extensions : [];
  const blockedExtensions = [...new Set([...DEFAULT_BLOCKED_EXTENSIONS, ...configuredBlocked.filter(value => typeof value === "string" && value.trim()).map(value => value.trim().toLowerCase())])];

  // validation.* thresholds were accepted, env-mapped and documented but never
  // enforced.
  const confidenceThreshold = Number(config.validation?.confidence_threshold);
  const maxChangedFiles = Number(config.validation?.max_changed_files);
  const validationEnabled = config.validation?.enabled !== false;

  if (!git.isGitRepo(repoRoot)) {
    throw new Error(`Not a git repository: ${repoRoot}`);
  }

  // A contract still marked "running" before this run starts belongs to a
  // crashed predecessor run — mark it interrupted so it cannot survive forever.
  const previousContract = readContract(repoRoot);
  if (previousContract && previousContract.status === "running" && previousContract.updated_at) {
    writeContract(repoRoot, { ...previousContract, status: "interrupted" });
  }
  writeContract(repoRoot, { status: "running", goal: task, verify_command: config.validation?.script_path || "VERIFY_CMD.sh" });

  let gateResult = null;
  if (opts.authorization !== TEST_AUTHORIZATION) {
    const { GateState } = require("../entitlement/gate");
    gateResult = await authorizeEntitlement({ entitlementDir: opts.entitlementDir, serverUrl: opts.serverUrl || resolveServerUrl() });
    if (!gateResult.allowed) {
      console.error(`\n🚫 Entitlement check failed: ${gateResult.message}`);
      if (gateResult.state === GateState.OFFLINE_GRACE) {
        console.warn("   Offline grace mode is temporary. Connect to the internet to renew.");
      }
      throw new Error(`Entitlement ${gateResult.state}: ${gateResult.message}`);
    }
    if (gateResult.state === GateState.OFFLINE_GRACE) {
      console.warn(`⚠️  ${gateResult.message}`);
    }
  }

  const providersConfig = config.providers || {};
  const configuredProviderNames = Object.keys(providersConfig);
  const defaultProvider = config.default_provider || configuredProviderNames[0] || "";
  const ALIAS_MAP = { claude: "anthropic", gpt: "openai", gemini: "google" };
  providerModule.configureRetries({
    maxRetries: config.execution?.max_retries === "unlimited" ? (Number(config.execution?.retry_hard_limit) || 5) : (Number(config.execution?.max_retries) || 5),
    backoffMs: (Number(config.execution?.retry_backoff_sec) || 1) * 1000,
    maxBackoffMs: (Number(config.execution?.retry_max_sec) || 30) * 1000,
  });
  const pricingFor = (providerName) => {
    const canonical = ALIAS_MAP[providerName] || providerName;
    return providersConfig[providerName]?.pricing || providersConfig[canonical]?.pricing || null;
  };
  const createRoleProvider = (role) => {
    const providerName = resolveProviderName(config, role, opts.providerOverride) || defaultProvider;
    if (!providerName) throw new Error(`No provider configured for role '${role}'. Configure default_provider or providers.`);
    const canonicalName = ALIAS_MAP[providerName] || providerName;
    const roleCfg = config.roles?.[role] || {};
    let provider = /** @type {any} */ (providerModule.createProvider(providerName, providersConfig[canonicalName] || providersConfig[providerName] || {}));
    if (roleCfg.fallback_model) {
      provider = new providerModule.FallbackProvider(provider, [roleCfg.fallback_model, ...(Array.isArray(roleCfg.fallback) ? roleCfg.fallback : [])]);
    }
    return { name: providerName, provider };
  };
  const roleProviders = {};
  for (const role of ["plan", "work", "review", "intel"]) {
    // The intel role is only needed when research is enabled; requiring its
    // credentials unconditionally made an unrelated missing key fatal.
    if (role === "intel" && !researchEnabled) continue;
    roleProviders[role] = createRoleProvider(role);
    if (!(await roleProviders[role].provider.isAvailable())) {
      throw new Error(`Provider '${roleProviders[role].name}' for role '${role}' is not available. Configure its credentials or choose another provider.`);
    }
  }

  const hardCycleLimit = Math.max(1, Number(config.budget.max_cycles_hard_limit) || 100);
  const hardTokenLimit = Math.max(1, Number(config.budget.token_hard_limit) || 2000000);
  const maxCyclesSetting = opts.overrides?.budget?.max_cycles ?? config.budget.max_cycles;
  const maxCycles = maxCyclesSetting === "unlimited" || maxCyclesSetting === 0 || maxCyclesSetting == null ? Infinity : Math.min(Number(maxCyclesSetting) || 1, hardCycleLimit);
  const tokenSetting = opts.overrides?.budget?.token_budget ?? config.budget.token_budget;
  const tokenBudget = tokenSetting === "unlimited" || tokenSetting === 0 || tokenSetting == null ? Infinity : Math.min(Number(tokenSetting) || 1, hardTokenLimit);
  const originalGoal = task;
  const hardTimeoutMs = (Number(config.execution?.timeout_hard_limit_sec) || 86400) * 1000;
  const deadline = Date.now() + hardTimeoutMs;
  const budgetChars = config.execution?.context_budget_chars || DEFAULT_CONTEXT_BUDGET_CHARS;
  const results = { cycles: [], totalTokens: { input: 0, output: 0 }, totalCost: 0, goal: originalGoal, evolution: {} };
  let confirmationGranted = false; // Track whether user approved changes for this run
  let stagnantCycles = 0;
  let lastChangeSignature = "";
  let lastFailureCategory = undefined; // classified failure category for the current run's last failing cycle
  let humanEscalation = false;

  // Model escalation + token hard guardrail.
  // Escalation moves the "work" adapter up the model-tier chain on repeated
  // failures or high-complexity errors (e.g. TYPE_ERROR), and halts the loop
  // with a human escalation signal when the token hard limit is approached —
  // instead of merely compressing context and retrying.
  const escfg = (config.execution && config.execution.escalation) || {};
  const failureAnalyzer = new FailureAnalyzer();
  const workProviderName = resolveProviderName(config, "work", opts.providerOverride) || defaultProvider;
  const workCanonical = ALIAS_MAP[workProviderName] || workProviderName;
  const escalationEngine = new EscalationEngine({
    failureThreshold: Number(escfg.failure_threshold) || 2,
    tokenHardLimit: hardTokenLimit,
    tokenStopRatio: Number(escfg.token_stop_ratio) || 0.9,
    escalationModels: escfg.models || {},
    role: "work",
    modelResolver: (targetTier) => {
      const m = findEscalationModel(workCanonical, targetTier);
      return m ? m.id : null;
    },
  });

  /** Apply a model-tier escalation to the work role. */
  const escalateWorkRole = (targetTier, model) => {
    const roleCfg = config.roles.work || {};
    if (model) {
      roleCfg.model = model;
      console.log(`  ⚡ Escalating work model → ${model} (tier: ${targetTier})`);
    } else {
      // No catalog model for this provider — enable reasoning/thinking instead.
      roleCfg.effort = "high";
      roleCfg.thinking = "enabled";
      roleCfg.thinking_budget = roleCfg.thinking_budget || 20000;
      console.log(`  ⚡ Escalating work to high-effort/reasoning mode (tier: ${targetTier})`);
    }
  };

  // Cost accumulation — uses optional per-provider pricing from minitok.yml
  // (providers.<name>.pricing = { input_per_mtok, output_per_mtok } in USD).
  const addCost = (role, tokens) => {
    const pricing = pricingFor(roleProviders[role]?.name);
    if (!pricing) return 0;
    const cost = providerModule._estimateCost(tokens, pricing).total;
    results.totalCost += cost;
    return cost;
  };

  // Self-evolution: adapt policy from past outcomes
  const knowledgeStore = new KnowledgeStore(opts.knowledgePath);
  let adaptedMaxCycles = Math.min(maxCycles, hardCycleLimit);
  if (knowledgeStore.size > 0) {
    const patterns = analyzeFailurePatterns(knowledgeStore.getAll());
    if (patterns.patterns.length > 0) {
      const { recommended, reasons } = recommendPolicy(patterns.patterns, {
        max_cycles: Number.isFinite(maxCycles) ? maxCycles : hardCycleLimit,
      });
      if (reasons.length > 0) {
        console.log("  🧬 Adaptive policy:");
        reasons.forEach(r => console.log(`     → ${r}`));
        adaptedMaxCycles = recommended.max_cycles;
      }
    }
  }
  results.evolution.knowledge_size = knowledgeStore.size;

  // Graceful shutdown on SIGINT/SIGTERM
  let _abortRequested = false;
  const _originalSigint = process.listeners("SIGINT").slice();
  const _originalSigterm = process.listeners("SIGTERM").slice();
  const _onSignal = (sig) => {
    _abortRequested = true;
    console.log(`\n⚠️  Received ${sig} — finishing current cycle then stopping...`);
  };
  process.on("SIGINT", _onSignal);
  process.on("SIGTERM", _onSignal);

  try {
  for (let cycle = 1; cycle <= adaptedMaxCycles; cycle++) {
    // Graceful shutdown check
    if (_abortRequested || opts.signal?.aborted) {
      console.log("🛑 Pipeline interrupted by signal.");
      break;
    }
    if (Date.now() >= deadline) {
      console.log("\n⏱️  Timeout hard limit reached. Stopping.");
      break;
    }
    // 💰 Token budget cap — prevent runaway LLM usage.
    const totalUsed = results.totalTokens.input + results.totalTokens.output;
    if (totalUsed >= tokenBudget || totalUsed >= hardTokenLimit) {
      if (escalationEngine.shouldStop(totalUsed)) {
        // Hard guardrail: beyond context compression, stop and escalate to a human.
        humanEscalation = true;
        lastFailureCategory = "timeout";
        console.log(`\n🙋 Token HARD limit reached (${totalUsed.toLocaleString()} / ${hardTokenLimit.toLocaleString()}). Stopping and escalating to a human reviewer — not merely compressing context.`);
      } else {
        console.log(`\n💰 Token budget reached (${totalUsed.toLocaleString()} / ${tokenBudget.toLocaleString()}). Stopping.`);
      }
      break;
    }

    console.log(`\n🔄 Cycle ${cycle}/${adaptedMaxCycles}`);
    // Context compaction (token savings)
    // P1: repo context is static on the real (non-isolated) repo while the
    // pipeline edits the disposable clone — compute once per run instead of
    // paying ~5 git spawns every cycle.
    rawRepoContext ??= getRepoContext(repoRoot);
    const repoContext = compactContext(rawRepoContext, budgetChars);
    writeContextManifest(repoRoot, { goal: task, source: "pipeline", budget_chars: budgetChars, original_chars: rawRepoContext.length, final_chars: repoContext.length, files: ["package.json", "README.md", "minitok.yml"].filter(file => fs.existsSync(path.join(repoRoot, file))) });

    // roles.<role>.timeout_sec is the documented per-request budget;
    // execution.timeout_hard_limit_sec bounds it (a role may not exceed the
    // ceiling). Both keys were previously unused: every request inherited the
    // fixed five minute transport timeout.
    const timeoutCeilingMs = Math.max(1000, (Number(config.execution?.timeout_hard_limit_sec) || 86400) * 1000);
    const roleTimeoutMs = (role) => {
      const seconds = Number(config.roles?.[role]?.timeout_sec);
      return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, timeoutCeilingMs) : timeoutCeilingMs;
    };
    const roleOpts = (role) => buildRoleOptions(config.roles[role], opts.signal, roleTimeoutMs(role));

    opts.onProgress?.({ phase: "intel", state: "started", cycle });
    let intelResult = { intelligence: undefined, tokens: { input: 0, output: 0 } };
    if (researchEnabled) {
      console.log("  🧭 Gathering repository intelligence...");
      intelResult = await intel(roleProviders.intel.provider, task, repoContext, roleOpts("intel"));
      results.totalTokens.input += intelResult.tokens?.input || 0;
      results.totalTokens.output += intelResult.tokens?.output || 0;
      addCost("intel", intelResult.tokens);
      opts.onProgress?.({ phase: "intel", state: "completed", cycle, tokens: intelResult.tokens, total_tokens: results.totalTokens, total_cost: results.totalCost });
    } else {
      console.log("  🧭 Repository intelligence disabled (execution.research_enabled: false)");
      opts.onProgress?.({ phase: "intel", state: "skipped", cycle });
    }

    // Phase 2: Plan
    opts.onProgress?.({ phase: "plan", state: "started", cycle });
    console.log("  📋 Planning...");
    const planResult = await plan(roleProviders.plan.provider, task, repoContext, { ...roleOpts("plan"), intelligence: intelResult.intelligence });
    results.totalTokens.input += planResult.tokens?.input || 0;
    results.totalTokens.output += planResult.tokens?.output || 0;
    addCost("plan", planResult.tokens);
    opts.onProgress?.({ phase: "plan", state: "completed", cycle, tokens: planResult.tokens, total_tokens: results.totalTokens, total_cost: results.totalCost });
    console.log(`     Plan: ${planResult.plan.error ? "❌ " + planResult.plan.error : "✅ " + (planResult.plan.steps?.length || 0) + " steps"}`);

    if (planResult.plan.error) {
      const _pfCat = failureAnalyzer.categorize(planResult.plan.error || "");
      lastFailureCategory = _pfCat;
      const _pfRec = escalationEngine.recordCycleOutcome(originalGoal, { success: false, category: _pfCat, tokens: (intelResult.tokens?.input || 0) + (intelResult.tokens?.output || 0) });
      if (_pfRec.stop) { console.log(`\n${_pfRec.stopReason}`); if (_pfRec.humanEscalation) humanEscalation = true; break; }
      if (_pfRec.escalate) escalateWorkRole(_pfRec.targetTier, _pfRec.model);
      results.cycles.push({ cycle, plan: planResult.plan, status: "plan_failed" });
      continue;
    }

    // Phase 3: Implement
    opts.onProgress?.({ phase: "work", state: "started", cycle });
    console.log("  🔧 Implementing...");
    const implResult = await implement(roleProviders.work.provider, planResult, repoContext, roleOpts("work"));
    results.totalTokens.input += implResult.tokens?.input || 0;
    results.totalTokens.output += implResult.tokens?.output || 0;
    addCost("work", implResult.tokens);
    opts.onProgress?.({ phase: "work", state: "completed", cycle, tokens: implResult.tokens, total_tokens: results.totalTokens, total_cost: results.totalCost });

    if (implResult.changes.error) {
      console.log(`     Implement: ❌ ${implResult.changes.error}`);
      const _icCat = failureAnalyzer.categorize(implResult.changes.error || "");
      lastFailureCategory = _icCat;
      const _icRec = escalationEngine.recordCycleOutcome(originalGoal, { success: false, category: _icCat, tokens: (intelResult.tokens?.input || 0) + (intelResult.tokens?.output || 0) + (planResult.tokens?.input || 0) + (planResult.tokens?.output || 0) });
      if (_icRec.stop) { console.log(`\n${_icRec.stopReason}`); if (_icRec.humanEscalation) humanEscalation = true; break; }
      if (_icRec.escalate) escalateWorkRole(_icRec.targetTier, _icRec.model);
      results.cycles.push({ cycle, plan: planResult.plan, implement: implResult.changes, status: "impl_failed" });
      continue;
    }

    // Apply changes — require user confirmation on first file modification
    const changeList = Array.isArray(implResult.changes?.changes) ? implResult.changes.changes : [];
    // validation.max_changed_files is a real safety bound: an oversized change set
    // is refused BEFORE anything is written, instead of being reported after the
    // fact. Nothing was enforced before, so the documented limit was advisory.
    if (Number.isFinite(maxChangedFiles) && maxChangedFiles > 0 && changeList.length > maxChangedFiles) {
      console.log(`     ❌ ${changeList.length} files changed, above validation.max_changed_files (${maxChangedFiles}). Nothing was applied.`);
      results.cycles.push({ cycle, plan: planResult.plan, implement: implResult.changes, status: "changes_exceeded_limit" });
      break;
    }
    let applyResult;
    if (confirmationGranted || opts.dryRun) {
      // Already confirmed this run, or dry-run (no mutation)
      applyResult = applyChanges(repoRoot, implResult.changes, opts.dryRun, { blockedExtensions });
    } else {
      const accepted = await promptConfirmation(implResult.changes, { ...opts, repoRoot });
      if (!accepted) {
        console.log("  ❌ Changes rejected by user. Stopping pipeline.");
        results.cycles.push({ cycle, plan: planResult.plan, implement: implResult.changes, status: "rejected_by_user" });
        break;
      }
      confirmationGranted = true;
      applyResult = applyChanges(repoRoot, implResult.changes, opts.dryRun, { blockedExtensions });
    }
    console.log(`     Applied: ${applyResult.applied} changes${applyResult.errors.length ? `, ${applyResult.errors.length} errors` : ""}`);

    // Phase 4: Check
    opts.onProgress?.({ phase: "verify", state: "started", cycle });
    if (!validationEnabled) console.log("  🧪 Verification disabled (validation.enabled: false).");
    else console.log("  🧪 Running verification command...");
    const checkResult = opts.dryRun
      ? { passed: true, evidence: { status: "skipped", command: "dry-run", output: "" } }
      : validationEnabled
        ? verifyCommand(repoRoot, { script_path: config.validation?.script_path, timeout_ms: config.validation?.timeout_ms })
        : { passed: true, evidence: { status: "skipped", command: "validation.enabled=false", output: "Verification command skipped by configuration." } };
    opts.onProgress?.({ phase: "verify", state: "completed", cycle, passed: checkResult.passed, total_tokens: results.totalTokens, total_cost: results.totalCost });

    // Phase 5: Review
    opts.onProgress?.({ phase: "review", state: "started", cycle });
    console.log("  🔍 Reviewing...");
    const verifyResult = await verify(roleProviders.review.provider, task, { changes: implResult.changes, check: checkResult }, repoRoot, roleOpts("review"));
    results.totalTokens.input += verifyResult.tokens?.input || 0;
    results.totalTokens.output += verifyResult.tokens?.output || 0;
    addCost("review", verifyResult.tokens);
    opts.onProgress?.({ phase: "review", state: "completed", cycle, tokens: verifyResult.tokens, total_tokens: results.totalTokens, total_cost: results.totalCost });
    const reviewVerdict = verifyResult.review.verdict || "UNKNOWN";
    const checkPassed = checkResult.passed;
    // validation.confidence_threshold was documented and unused. It is applied
    // only when the model reported a numeric confidence; a missing value keeps the
    // previous behaviour rather than silently failing a good review.
    const reportedConfidence = Number(verifyResult.review.confidence);
    const lowConfidence = reviewVerdict === "APPROVE" && Number.isFinite(confidenceThreshold) && confidenceThreshold > 0
      && Number.isFinite(reportedConfidence) && reportedConfidence < confidenceThreshold;
    const verdict = !checkPassed ? "VERIFICATION_FAILED" : lowConfidence ? "LOW_CONFIDENCE" : reviewVerdict;
    const icon = verdict === "APPROVE" ? "✅" : "❌";
    console.log(`     Review: ${icon} ${verdict} (confidence: ${verifyResult.review.confidence || "N/A"})`);
    if (lowConfidence) console.log(`     Confidence ${reportedConfidence} is below validation.confidence_threshold (${confidenceThreshold}); continuing.`);

    const changeSignature = JSON.stringify({ status: verdict, files: implResult.changes?.changes?.map(change => change.file) || [] });
    if (changeSignature === lastChangeSignature || !(implResult.changes?.changes || []).length) stagnantCycles += 1;
    else stagnantCycles = 0;
    lastChangeSignature = changeSignature;
    if (stagnantCycles >= (config.budget.stagnation_limit || 3)) {
      console.log(`\n🛑 Stagnation limit reached (${stagnantCycles} cycles). Stopping.`);
      break;
    }

    results.cycles.push({
      cycle,
      intelligence: intelResult.intelligence,
      plan: planResult.plan,
      implement: { summary: implResult.changes.summary, files_changed: implResult.changes.files_changed, changed_files: (implResult.changes.changes || []).map(change => change.file) },
      check: checkResult.evidence,
      review: verifyResult.review,
      verify: verifyResult.review,
      tokens: {
        input: (intelResult.tokens?.input || 0) + (planResult.tokens?.input || 0) + (implResult.tokens?.input || 0) + (verifyResult.tokens?.input || 0),
        output: (intelResult.tokens?.output || 0) + (planResult.tokens?.output || 0) + (implResult.tokens?.output || 0) + (verifyResult.tokens?.output || 0),
      },
      status: verdict,
    });

    // ---- Model escalation + token hard guardrail ----
    // Classify this cycle's failure and drive escalation: after N successive
    // failures (or a high-complexity error such as TYPE_ERROR) the work
    // adapter is promoted to a higher-tier/reasoning model; when the token
    // hard limit is approached the loop halts and escalates to a human
    // rather than continuing to compress context and retry.
    const cycleTokens = (intelResult.tokens?.input || 0) + (planResult.tokens?.input || 0) + (implResult.tokens?.input || 0) + (verifyResult.tokens?.input || 0)
      + (intelResult.tokens?.output || 0) + (planResult.tokens?.output || 0) + (implResult.tokens?.output || 0) + (verifyResult.tokens?.output || 0);
    const failureEvidence = `${checkResult.evidence?.output || ""}\n${(verifyResult.review?.findings || []).map(f => f.message || "").join("\n")}\n${implResult.changes?.error || ""}`.trim();
    const failureCategory = failureEvidence ? failureAnalyzer.categorize(failureEvidence) : "unknown";
    const cycleSuccess = verdict === "APPROVE";
    if (!cycleSuccess) lastFailureCategory = failureCategory;
    const escRec = escalationEngine.recordCycleOutcome(originalGoal, { success: cycleSuccess, category: failureCategory, tokens: cycleTokens });
    if (escRec.stop) {
      console.log(`\n${escRec.stopReason}`);
      if (escRec.humanEscalation) { humanEscalation = true; lastFailureCategory = "timeout"; }
      break;
    }
    if (escRec.escalate) escalateWorkRole(escRec.targetTier, escRec.model);

    // If approved, goal-directed: check if overall goal is achieved
    // The goal-progress gate uses the configured confidence threshold instead of a
    // hardcoded 0.8, so validation.confidence_threshold means one thing.
    const goalConfidenceFloor = Number.isFinite(confidenceThreshold) && confidenceThreshold > 0 ? confidenceThreshold : 0.8;
    if (verdict === "APPROVE" && (Number(verifyResult.review.confidence) || 0) >= goalConfidenceFloor) {
      if (cycle < adaptedMaxCycles && !opts.dryRun) {
        console.log("  🧠 Evaluating goal progress...");
        const nextResult = await generateNextTask(roleProviders.plan.provider, originalGoal, results.cycles, verifyResult.review, roleOpts("plan"));
        results.totalTokens.input += nextResult.tokens?.input || 0;
        results.totalTokens.output += nextResult.tokens?.output || 0;
        if (nextResult.done) {
          console.log(`  ✅ Goal achieved: ${nextResult.summary || "All objectives met"}`);
          break;
        } else if (nextResult.next_task) {
          console.log(`  📌 Next task: ${nextResult.next_task}`);
          task = nextResult.next_task;
        }
      } else {
        console.log("\n✅ Task completed successfully!");
        break;
      }
    }

    // Phase 6: Repair
    if (verdict === "REJECT" || verdict === "VERIFICATION_FAILED") {
      console.log(`  🔧 Preparing ${verdict === "VERIFICATION_FAILED" ? "verification repair" : "review repair"} task...`);
      task = buildRepairTask(originalGoal, verifyResult.review, checkResult);
    }
  }
  } catch (error) {
    writeContract(repoRoot, { status: "failed", goal: originalGoal, verify_command: config.validation?.script_path || "VERIFY_CMD.sh", error: error.message });
    throw error;
  } finally {
    restoreSignalListeners("SIGINT", _originalSigint, _onSignal);
    restoreSignalListeners("SIGTERM", _originalSigterm, _onSignal);
  }

  const elapsed = Date.now() - startTime;
  const success = results.cycles.some(c => c.status === "APPROVE");

  // Self-evolution: record outcome
  const totalTokens = results.totalTokens.input + results.totalTokens.output;
  const uploadSafeCategory = lastFailureCategory && ALLOWED_FIELDS.failure_category.values.includes(lastFailureCategory) ? lastFailureCategory : undefined;
  knowledgeStore.record(/** @type {any} */ ({
    project: path.resolve(repoRoot),
    goal: originalGoal,
    status: success ? "success" : "failure",
    cycles: results.cycles.length,
    total_tokens: totalTokens,
    total_cost: Math.round((results.totalCost || 0) * 10000) / 10000,
    duration_ms: elapsed,
    files_changed: results.cycles.reduce((sum, c) => sum + (c.implement?.files_changed || 0), 0),
    failure_category: lastFailureCategory,
     summary: `${results.cycles.length} cycles, ${success ? "success" : "failure"}`,
   }));
  results.evolution.knowledge_size = knowledgeStore.size;

  // M14: Attempt evolution upload (non-blocking, errors swallowed).
  // Only sanitized telemetry is sent — never goal/summary/project data.
  // uploadEvolutionOutcome enforces: entitlement → feature → opt-in → sanitize → network.
  // If ANY check fails, no network request is made. Upload failure never affects project execution.
  const uploadOutcome = {
    status: success ? "success" : "failure",
    cycles: results.cycles.length,
    duration_ms: elapsed,
    files_changed: results.cycles.reduce((sum, c) => sum + (c.implement?.files_changed || 0), 0),
    total_tokens: totalTokens,
    failure_category: uploadSafeCategory,
  };
  try {
    const creds = _loadUploadCredentials();
    const uploadResult = await uploadEvolutionOutcome(uploadOutcome, {
      _entitlementCheck: gateResult || undefined,
      serverUrl: opts.serverUrl || creds?.serverUrl || undefined,
      token: opts.installationToken || creds?.token || undefined,
    });
    results.evolution.upload = uploadResult.sent ? "sent" : "skipped";
  } catch {
    results.evolution.upload = "error";
  }

  const elapsedSec = (elapsed / 1000).toFixed(1);
  const costNote = results.totalCost > 0 ? `, ~$${results.totalCost.toFixed(4)}` : "";
  console.log(`\n📊 Summary: ${results.cycles.length} cycles, ${totalTokens.toLocaleString()} tokens (${results.totalTokens.input.toLocaleString()} in + ${results.totalTokens.output.toLocaleString()} out)${costNote}, ${elapsedSec}s`);
  console.log(`🧬 Evolution: ${knowledgeStore.size} outcomes recorded`);

  results.success = success;
  results.humanEscalation = humanEscalation;
  if (humanEscalation) {
    console.log(`\n🙋 Human escalation engaged: the token hard limit was reached. Manual review is required.`);
  }
  writeContract(repoRoot, { status: success ? "completed" : "failed", goal: originalGoal, verify_command: config.validation?.script_path || "VERIFY_CMD.sh", cycles: results.cycles.length, success, human_escalation: humanEscalation });
  try {
    await recordRunEvidence({
      workspaceRoot: repoRoot,
      task: originalGoal,
      dry_run: Boolean(opts.dryRun),
      stages: {
        selected_plan: results.cycles.at(-1)?.plan || null,
        work: results.cycles.at(-1)?.implement || null,
        review: results.cycles.at(-1)?.review || null,
      },
      changed_files: results.cycles.flatMap(c => c.implement?.changed_files || []),
      verification: {
        commands: results.cycles.map(c => c.check?.command).filter(Boolean),
        exit_status: results.cycles.at(-1)?.check?.exit_code ?? null,
        passed: results.cycles.at(-1)?.check?.status === "passed",
      },
      outcome: success ? "success" : "verification-failed",
    });
  } catch (error) {
    console.warn(`⚠️  Could not save run evidence: ${error.message}`);
  }
  return results;
}

async function runPipeline(task, opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, "skipEntitlementCheck")) {
    throw new Error("skipEntitlementCheck is not supported");
  }
  if (opts.signal?.aborted) throw Object.assign(new Error("Run cancelled"), { code: "RUN_CANCELLED" });
  if (opts.isolatedWorkspace) return runPipelineInWorkspace(task, opts);
  const { createIsolatedWorkspace, applyWorkspaceDiff, removeIsolatedWorkspace } = require("../workspace/isolation");
  const { acquireRunLock } = require("../state/run-lock");
  const repoRoot = opts.repoRoot || process.cwd();
  if (!git.isGitRepo(repoRoot)) throw new Error(`Not a git repository: ${repoRoot}`);
  const runLock = acquireRunLock(repoRoot);
  let isolated;
  try {
    isolated = createIsolatedWorkspace(repoRoot, opts.isolationRoot);
    // Heal the REAL repository's contract: a contract still marked "running"
    // here belongs to a crashed predecessor run (we hold the run lock now).
    // The clone's own contract is irrelevant — .minitok/ is gitignored, so
    // the clone never contains the real one.
    const { readContract: readRealContract, writeContract: writeRealContract } = require("../state/contracts");
    const realContract = readRealContract(repoRoot);
    if (realContract && realContract.status === "running" && realContract.updated_at) {
      writeRealContract(repoRoot, { ...realContract, status: "interrupted" });
    }
    const result = await runPipelineInWorkspace(task, { ...opts, repoRoot: isolated.path, isolatedWorkspace: true });
    let applied = false;
    if (result.success && !opts.dryRun) {
      try {
        applyWorkspaceDiff(repoRoot, isolated.path);
        applied = true;
      } catch (applyError) {
        // Do NOT discard paid pipeline output: the patch is preserved at
        // .minitok/last-run.patch (see isolation.js) — surface it clearly.
        applyError.message = `${applyError.message}\nThe run itself succeeded; only the final merge into your repository failed.`;
        throw applyError;
      }
    } else if (!result.success && !opts.dryRun) {
      // A run that ended in REJECT/verification-failure still produced paid
      // work. Preserve the generated diff so the customer can inspect or
      // salvage it instead of silently losing everything with the clone.
      try {
        const { preserveWorkspaceDiff } = require("../workspace/isolation");
        preserveWorkspaceDiff(repoRoot, isolated.path);
      } catch {}
    }
    // Propagate run evidence out of the disposable clone — the default path
    // removes the isolated workspace, which would otherwise destroy
    // .minitok/evidence/ before it reaches the real repository (README:39-41).
    try {
      const evidencePath = path.join(isolated.path, ".minitok", "evidence", "runs", "latest.json");
      const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
      if (evidence && evidence.run_id) {
        await recordRunEvidence({ workspaceRoot: repoRoot, ...evidence });
      }
    } catch {
      // Evidence propagation is best-effort and must never fail the run.
    }
    return { ...result, isolation: { path: isolated.path, applied } };
  } finally {
    try {
      if (isolated) removeIsolatedWorkspace(isolated.path);
    } finally {
      runLock.release();
    }
  }
}

module.exports = { runPipeline, runPipelineInWorkspace, getRepoContext, compactContext, buildRoleOptions, promptConfirmation, approvalRequest, validateApprovalResponse, writeApprovalRequest };

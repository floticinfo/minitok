"use strict";

const { WorkspaceManager } = require("../../workspace/manager");
const { runPipeline } = require("../../pipeline/loop");
const { normalizeProvider } = require("../../auth/aliases");
const { PREAUTHORIZED } = require("../../pipeline/authorization");
const { resolveExecutionPolicy } = require("../../goal/execution_policy");
const { loadConfig } = require("../../config/loader");
const path = require("path");
const crypto = require("crypto");
const { resolveServerUrl } = require("./server-config");
const { capabilityPermissions, FULL_TEST_PROFILE } = require("../../entitlement/capability");
const { createRunSession, loadRunSession, latestRunSession, appendRunEvent, buildSessionContextBlock } = require("./run-session-store");
const { expandTaskContext } = require("./task-context");

// Resolve the session this run belongs to and prepend prior-turn context.
// A corrupt or unknown --resume id falls back to a fresh session rather than
// failing the run: conversation history is an ergonomic aid, not a correctness
// requirement, and a broken session file must never block a user's task.
function openRunSession(repoRoot, task, resume) {
  const resumeId = typeof resume === "string" ? resume.trim() : "";
  let session = null;
  if (resume === true || resumeId) {
    session = resumeId ? loadRunSession(repoRoot, resumeId) : latestRunSession(repoRoot);
    if (!session) console.warn(`[warn] No usable session to resume (${resumeId || "latest"}); starting a new one.`);
  }
  if (!session) {
    try { session = createRunSession(repoRoot, task); }
    catch (error) {
      console.warn(`[warn] Could not create run session: ${error.message}`);
      return null;
    }
  }
  return session;
}

function ensureRunId(opts) {
  if (typeof opts.runId === "string" && opts.runId.trim()) return opts.runId.trim();
  opts.runId = crypto.randomUUID();
  return opts.runId;
}


function classifyProviderHealth(name, available, health) {
  if (!available.includes(name)) return "absent";
  if (!health.has(name)) return "unprobed";
  const status = health.get(name)?.status;
  if (["ok", "skipped", "invalid", "network_error", "absent"].includes(status)) return status;
  return "error";
}

async function cmdRun(task, opts = {}) {
  const capability = capabilityPermissions({ filePath: opts.capabilityFile });
  const capabilityGranted = capability.record?.profile === FULL_TEST_PROFILE ? capability.record.capabilities : [];
  const requestedCapabilities = typeof opts.capabilities === "string" ? opts.capabilities.split(",").map(item => item.trim()).filter(Boolean) : (opts.capabilities || (capabilityGranted.length ? capabilityGranted : undefined));
  const autoAcceptGranted = opts.autoAccept === true || capabilityGranted.includes("auto_accept");
  // One identifier binds provider preflight, trial consumption, pipeline state,
  // evidence, and retries. Never let a real run reach the quota endpoint without
  // an idempotency key.
  ensureRunId(opts);
  let config;
  let policyDecision = null;
  if (!task) {
    console.error("Error: Task description required.\n\nUsage: minitok run \"Fix authentication bug\"");
    return 1;
  }

  // Resolve repository
  let repoRoot;
  if (opts.repo) {
    repoRoot = path.resolve(opts.repo);
  } else {
    try {
      const wm = new WorkspaceManager();
      const ws = wm.resolve(opts.workspace);
      repoRoot = ws.repository_root;
      console.log(`Workspace: ${ws.name} (${repoRoot})`);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      return 1;
    }
  }
  // Open the conversation session before preflight so the session id is known
  // even when a later gate rejects the run — the attempt is part of the thread.
  const runSession = openRunSession(repoRoot, task, opts.resume);
  // Only a resumed session carries prior turns; a brand new session's context
  // block would just restate the task we are about to send.
  const contextualTask = runSession && opts.resume
    ? `${buildSessionContextBlock(runSession)}${task}`
    : task;
  // Resolve the Extension's @file / @folder attachments against the repository.
  // Without this the markers reached the model as literal text it cannot read,
  // so "Attach file" silently did nothing.
  const { task: pipelineTask, expanded, skipped } = expandTaskContext(contextualTask, repoRoot);
  if (expanded > 0 || skipped > 0) console.log(`MINITOK_CONTEXT_INFO ${JSON.stringify({ expanded, skipped })}`);
  // Tell the extension (and any log reader) which thread this run belongs to.
  // Session events use the same line protocol as approvals so the extension
  // needs no extra transport.
  if (runSession) console.log(`MINITOK_SESSION_INFO ${JSON.stringify({ session_id: runSession.id, resumed: opts.resume === true || typeof opts.resume === "string" })}`);

  if (opts.mode) {
    config = loadConfig(path.join(repoRoot, "minitok.yml"), { repoRoot });
    policyDecision = resolveExecutionPolicy({ mode: opts.mode, capabilities: requestedCapabilities, explicit_confirmation: opts.explicitConfirmation === true || capabilityGranted.length > 0, auto_accept: autoAcceptGranted, runtime_permission: capabilityGranted.includes("unrestricted_autonomous") || capabilityGranted.includes("unrestricted_general_autonomous"), source: "cli", actor: opts.actor, config });
    if (!policyDecision.allowed && !policyDecision.approval_required) {
      console.error(`Execution policy denied: ${policyDecision.reason}`);
      return 1;
    }
  }

    // Preflight: fail fast with a setup guide when no provider credentials exist,
  // or when a provider key is rejected by the API (401/403). Otherwise
  // runPipeline would burn cycles and only fail at the first real request.
  let preflightAuthorized = opts.authorization === PREAUTHORIZED;
  if (!preflightAuthorized) try {
    const { loadConfig, resolveProviderName } = require("../../config/loader");
    const { authorizeEntitlement } = require("../../entitlement/policy");
    const { consumeTrialRun } = require("../../entitlement/online");
    const { EntitlementStore } = require("../../entitlement/store");
    const { detectAvailableProviders, verifyCredentials } = require("../../llm/provider");
    let preflightConfig;
    try {
      preflightConfig = loadConfig(require("path").join(repoRoot, "minitok.yml"));
    } catch (configError) {
      // A malformed minitok.yml must stop the run before any provider probe: the
      // pipeline would otherwise proceed with defaults the user never wrote.
      console.error(`Error: ${configError.message}`);
      return 1;
    }
    // Authorization must precede every provider network probe. A provider health
    // check is still billable/observable provider work, so an unentitled run must
    // fail before detectAvailableProviders or verifyCredentials can contact an API.
    if (opts.authorization !== PREAUTHORIZED) {
      let gate;
      // A run delegation token (extension-host admin run) is bound to the runId
      // by the issuing server, so the preflight passes the id along for the
      // binding check. The id also keys trial idempotency further below.
      try { gate = await authorizeEntitlement({ serverUrl: opts.serverUrl || resolveServerUrl(), entitlementDir: opts.entitlementDir, delegationRunIds: [ensureRunId(opts)] }); }
      catch (error) { console.error(`Error: Entitlement check failed: ${error instanceof Error ? error.message : String(error)}`); return 1; }
      if (!gate.allowed) {
        console.error(`Error: Entitlement ${gate.state}: ${gate.message}`);
        return 1;
      }
      preflightAuthorized = true;
      opts.trialEntitlement = gate.trial === true;
    }
    const available = await detectAvailableProviders(preflightConfig);
    if (available.length === 0) {
      console.error("Error: No LLM provider is configured.\n");
      console.error("minitok needs one API key before it can run. Pick one:");
      console.error("  $env:ANTHROPIC_API_KEY='sk-ant-...'   # Claude");
      console.error("  $env:OPENAI_API_KEY='sk-...'          # GPT");
      console.error("  $env:GEMINI_API_KEY='...'             # Gemini");
      console.error("");
      console.error("Or save a key persistently:  minitok auth login <anthropic|openai|google>");
      console.error("Then verify with:  minitok doctor");
      return 1;
    }

    // Live-check credentials, then judge only the providers the roles actually
    // resolve to. Scope matters: a stale unrelated token (e.g. an old
    // ~/.minitok/tokens/anthropic.json) must not abort an OpenAI-only run — the
    // earlier "any rejected provider is fatal" rule made that configuration
    // completely unrunnable. Only the resolved providers are probed: verifying
    // every available key cost up to 8 seconds per unused provider, and
    // `minitok doctor --verify` is the command that audits all of them.
    const canonical = normalizeProvider;
    const override = canonical(opts.providerOverride);
    const adapterOverrides = { plan: opts.planAdapter, work: opts.codingAdapter, intel: opts.researchAdapter, review: opts.reviewAdapter };
    const preflightRoles = JSON.parse(JSON.stringify(preflightConfig));
    for (const [role, adapter] of Object.entries(adapterOverrides)) {
      if (typeof adapter !== "string" || !adapter.trim()) continue;
      preflightRoles.roles = preflightRoles.roles || {};
      // Match runPipeline: a CLI role-adapter flag is an explicit provider
      // choice and must win over default_provider during preflight too.
      preflightRoles.roles[role] = { ...(preflightRoles.roles[role] || {}), provider: adapter.trim(), adapter: adapter.trim() };
    }
    const researchEnabled = preflightRoles.execution?.research_enabled !== false;
    const roleNames = Object.keys(preflightRoles.roles || {}).filter(role => researchEnabled || role !== "intel");
    let needed = [...new Set(roleNames.map(role => canonical(resolveProviderName(preflightRoles, role, opts.providerOverride))).filter(Boolean))];
    if (override) needed = [override];
    // Nothing selects a provider anywhere -> the pipeline auto-detects, so every
    // available provider is a live candidate and each one has to be healthy.
    if (needed.length === 0) needed = available.slice();

    const health = new Map();
    for (const name of needed) {
      health.set(name, await verifyCredentials(name, preflightRoles.providers?.[name] || preflightConfig.providers?.[name] || {}));
    }
    const statusOf = (name) => classifyProviderHealth(name, available, health);
    const blocking = needed.filter(name => !["ok", "skipped"].includes(statusOf(name)));
    const alternatives = available.filter(name => !needed.includes(name));

    const skipped = needed.filter(name => statusOf(name) === "skipped");
    if (skipped.length > 0) console.warn(`[warn] provider preflight skipped for local/no-auth provider(s): ${skipped.join(", ")}`);

    if (blocking.length > 0) {
      console.error("Error: one or more providers required by the configured roles are not ready:\n");
      for (const name of blocking) {
        const state = statusOf(name);
        const detail = health.get(name)?.detail || (state === "absent" ? "no credentials configured" : "provider preflight failed");
        console.error(`  ${name}: ${state} — ${detail}`);
      }
      if (alternatives.length > 0) {
        console.error(`\nOther configured providers: ${alternatives.join(", ")} (not probed)`);
        console.error(`Try:  minitok run "<task>" --provider-override ${alternatives[0]}`);
        console.error(`Or set it permanently: change roles.*.provider / default_provider in minitok.yml`);
      }
      console.error("\nRenew the rejected key:  minitok auth login <provider>   (or set the provider environment variable)");
      console.error("Then confirm with:      minitok doctor --verify");
      return 1;
    }


    // A dry-run performs the model-backed preview but does not consume a
    // server-side trial quota because it does not apply repository changes.
    if (!opts.dryRun && opts.trialEntitlement && !opts.trialRunConsumed) {
      const trialResult = await consumeTrialRun({
        serverUrl: opts.serverUrl || resolveServerUrl(),
        entitlementDir: opts.entitlementDir,
        _loadArtifact: () => new EntitlementStore(opts.entitlementDir).load(),
        idempotencyKey: opts.runId,
      });
      if (!trialResult.consumed) {
        console.error(`Error: Trial run unavailable: ${trialResult.message}`);
        return 1;
      }
      opts.trialRunConsumed = true;
    }
  } catch (preflightError) {
    console.error(`Error: Provider preflight failed${preflightError?.code ? ` [${preflightError.code}]` : ""}: ${preflightError instanceof Error ? preflightError.message : String(preflightError)}`);
    return 1;
  }

  try {
    const result = await runPipeline(pipelineTask, {
      repoRoot,
      // cmdRun already performed the gate before provider preflight. Pass the
      // internal authorization marker so runPipeline does not perform a second
      // network validation after the provider checks.
      authorization: preflightAuthorized ? PREAUTHORIZED : opts.authorization,
      trialEntitlement: opts.trialEntitlement === true,
      trialRunConsumed: opts.trialRunConsumed === true,
      serverUrl: opts.serverUrl || resolveServerUrl(),
      dryRun: opts.dryRun,
      // Approval and cancellation options must reach the pipeline. They were
      // parsed by the CLI and then dropped here, so the documented
      // `run --approval-file` contract never fired: the extension sidebar's
      // Approve/Reject flow waited for a request that was never written, and a
      // non-TTY run refused every change for lack of a terminal.
      approvalFile: opts.approvalFile,
      approvalTimeoutMs: Number.isFinite(Number(opts.approvalTimeoutMs)) ? Number(opts.approvalTimeoutMs) : undefined,
      evidencePath: typeof opts.evidencePath === "string" ? opts.evidencePath : undefined,
      runId: ensureRunId(opts),
      signal: opts.signal,
      autoAccept: policyDecision ? policyDecision.allowed === true && opts.autoAccept === true : opts.autoAccept === true,
      providerOverride: opts.providerOverride,
      planAdapter: opts.planAdapter,
      codingAdapter: opts.codingAdapter,
      researchAdapter: opts.researchAdapter,
      reviewAdapter: opts.reviewAdapter,
    });

    // Save results — best-effort, never block pipeline on write errors
    try {
      const fs = require("fs");
      const { redact } = require("../../run-evidence");
      const evidenceDir = path.join(repoRoot, ".minitok");
      fs.mkdirSync(evidenceDir, { recursive: true });
      const lastRunPath = path.join(evidenceDir, "last-run.json");
      const tmpPath = `${lastRunPath}.tmp.${process.pid}.${require("crypto").randomBytes(6).toString("hex")}`;
      // Redact the same way run evidence is sanitized — plans/review LLM
      // output may contain whatever the user pasted into the task.
      fs.writeFileSync(tmpPath, JSON.stringify(redact({ task, timestamp: new Date().toISOString(), ...result }), null, 2), "utf-8");
      fs.renameSync(tmpPath, lastRunPath);
    } catch (writeErr) {
      console.warn(`[warn] Could not save last-run.json: ${writeErr.message}`);
    }

    // Check the actual pipeline outcome — `success` follows the FINAL cycle (see
    // summarizeRunOutcome in src/pipeline/loop.js): a run that ends on a rejection
    // exits non-zero even when an earlier cycle was approved. `result.approved`
    // says whether such a change set exists (it is preserved, not merged).
// Record the outcome so the next --resume turn can cite it. Best-effort
    // like last-run.json: a session write must not change the exit code the
    // pipeline outcome already decided.
    if (runSession) {
      const changed = result && result.stages && result.stages.work && result.stages.work.changed_files;
      appendRunEvent(repoRoot, runSession, {
        type: "result",
        ok: result.success === true,
        runId: ensureRunId(opts),
        evidencePath: typeof opts.evidencePath === "string" ? opts.evidencePath : undefined,
        filesChanged: Array.isArray(changed) ? changed.length : undefined,
      });
    }
    const exitCode = result.success ? 0 : 1;
    return exitCode;
  } catch (e) {
    console.error(`Pipeline error: ${e.message}`);
    return 1;
  }
}

module.exports = { cmdRun, classifyProviderHealth };

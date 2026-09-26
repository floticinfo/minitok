"use strict";

const { WorkspaceManager } = require("../../workspace/manager");
const { runPipeline } = require("../../pipeline/loop");
const { normalizeProvider } = require("../../auth/aliases");
const { PREAUTHORIZED } = require("../../pipeline/authorization");
const { resolveExecutionPolicy } = require("../../goal/execution_policy");
const { loadConfig } = require("../../config/loader");
const path = require("path");
const { capabilityPermissions, revalidateCapabilityRecord, FULL_TEST_PROFILE, UNRESTRICTED_LOCAL_PROFILE, UNRESTRICTED_LOCAL_CAPABILITIES } = require("../../entitlement/capability");

function classifyProviderHealth(name, available, health) {
  if (!available.includes(name)) return "absent";
  if (!health.has(name)) return "unprobed";
  const status = health.get(name)?.status;
  if (["ok", "skipped", "invalid", "network_error", "absent"].includes(status)) return status;
  return "error";
}

async function cmdRun(task, opts = {}) {
  const capability = capabilityPermissions({ filePath: opts.capabilityFile });
  const capabilityRecord = capability.record?.profile === UNRESTRICTED_LOCAL_PROFILE ? await revalidateCapabilityRecord({ filePath: opts.capabilityFile }) : capability.record;
  const capabilityGranted = capabilityRecord?.profile === FULL_TEST_PROFILE || capabilityRecord?.profile === UNRESTRICTED_LOCAL_PROFILE && opts.mode === "unrestricted" ? capabilityRecord.capabilities : [];
  const useLocalGrant = capabilityRecord?.profile === UNRESTRICTED_LOCAL_PROFILE && opts.mode === "unrestricted";
  const requestedCapabilities = typeof opts.capabilities === "string" ? opts.capabilities.split(",").map(item => item.trim()).filter(Boolean) : (opts.capabilities || (useLocalGrant || capabilityRecord?.profile === FULL_TEST_PROFILE ? capabilityGranted : undefined));
  if (useLocalGrant && requestedCapabilities?.some(item => !UNRESTRICTED_LOCAL_CAPABILITIES.includes(item))) { console.error("Error: The unrestricted_local grant does not include one or more requested capabilities"); return 1; }
  const autoAcceptGranted = opts.autoAccept === true || opts.mode === "unrestricted" && capabilityGranted.includes("auto_accept");
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
  if (opts.mode) {
    config = loadConfig(path.join(repoRoot, "minitok.yml"), { repoRoot });
    policyDecision = resolveExecutionPolicy({ mode: opts.mode, capabilities: requestedCapabilities, explicit_confirmation: opts.explicitConfirmation === true || useLocalGrant || capabilityRecord?.profile === FULL_TEST_PROFILE, auto_accept: autoAcceptGranted, runtime_permission: capabilityGranted.includes("unrestricted_autonomous") || capabilityGranted.includes("unrestricted_general_autonomous"), source: "cli", actor: opts.actor, config });
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
      try { gate = await authorizeEntitlement({ serverUrl: opts.serverUrl }); }
      catch (error) { console.error(`Error: Entitlement check failed: ${error instanceof Error ? error.message : String(error)}`); return 1; }
      if (!gate.allowed) {
        console.error(`Error: Entitlement ${gate.state}: ${gate.message}`);
        return 1;
      }
      preflightAuthorized = true;
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
    const adapterOverrides = { work: opts.codingAdapter, intel: opts.researchAdapter, review: opts.reviewAdapter };
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


  } catch (preflightError) {
    if (preflightError && preflightError.code) throw preflightError;
    // Config load failure surfaces below with full context; do not mask it.
  }

  try {
    const result = await runPipeline(task, {
      repoRoot,
      // cmdRun already performed the gate before provider preflight. Pass the
      // internal authorization marker so runPipeline does not perform a second
      // network validation after the provider checks.
      authorization: preflightAuthorized ? PREAUTHORIZED : opts.authorization,
      serverUrl: opts.serverUrl,
      dryRun: opts.dryRun,
      // Approval and cancellation options must reach the pipeline. They were
      // parsed by the CLI and then dropped here, so the documented
      // `run --approval-file` contract never fired: the extension sidebar's
      // Approve/Reject flow waited for a request that was never written, and a
      // non-TTY run refused every change for lack of a terminal.
      approvalFile: opts.approvalFile,
      approvalTimeoutMs: Number.isFinite(Number(opts.approvalTimeoutMs)) ? Number(opts.approvalTimeoutMs) : undefined,
      evidencePath: typeof opts.evidencePath === "string" ? opts.evidencePath : undefined,
      runId: typeof opts.runId === "string" ? opts.runId : undefined,
      signal: opts.signal,
      autoAccept: policyDecision ? policyDecision.allowed === true && (opts.autoAccept === true || opts.mode === "unrestricted" && capabilityGranted.includes("auto_accept")) : opts.autoAccept === true,
      providerOverride: opts.providerOverride,
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
    const exitCode = result.success ? 0 : 1;
    return exitCode;
  } catch (e) {
    console.error(`Pipeline error: ${e.message}`);
    return 1;
  }
}

module.exports = { cmdRun, classifyProviderHealth };

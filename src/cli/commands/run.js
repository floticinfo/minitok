"use strict";

const { WorkspaceManager } = require("../../workspace/manager");
const { runPipeline } = require("../../pipeline/loop");
const path = require("path");

async function cmdRun(task, opts) {
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

    // Preflight: fail fast with a setup guide when no provider credentials exist,
  // or when a provider key is rejected by the API (401/403). Otherwise
  // runPipeline would burn cycles and only fail at the first real request.
  try {
    const { loadConfig, resolveProviderName } = require("../../config/loader");
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
    const aliasOf = { claude: "anthropic", gpt: "openai", gemini: "google" };
    const canonical = (name) => aliasOf[String(name || "").toLowerCase()] || String(name || "").toLowerCase();
    const override = canonical(opts.providerOverride);
    const roleNames = Object.keys(preflightConfig.roles || {});
    let needed = [...new Set(roleNames.map(role => canonical(resolveProviderName(preflightConfig, role, opts.providerOverride))).filter(Boolean))];
    if (override) needed = [override];
    // Nothing selects a provider anywhere -> the pipeline auto-detects, so every
    // available provider is a live candidate and each one has to be healthy.
    if (needed.length === 0) needed = available.slice();

    const health = new Map();
    for (const name of needed) {
      health.set(name, await verifyCredentials(name, preflightConfig.providers?.[name] || {}));
    }
    const statusOf = (name) => {
      if (!available.includes(name)) return "absent";
      if (!health.has(name)) return "unprobed";
      return (health.get(name) || {}).status === "invalid" ? "dead" : "ok";
    };
    const neededOk = needed.filter(name => statusOf(name) === "ok");
    const alternatives = available.filter(name => !needed.includes(name));

    if (neededOk.length === 0) {
      console.error("Error: no usable LLM provider for the configured roles (401/403 on every candidate):\n");
      for (const name of needed) {
        const state = statusOf(name);
        const detail = state === "dead" ? (health.get(name) || {}).detail || "key rejected" : "no credentials configured";
        console.error(`  ${name}: ${detail}`);
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

    const deadNeeded = needed.filter(name => statusOf(name) === "dead");
    if (deadNeeded.length > 0) {
      console.warn(`[warn] some roles point at a rejected provider (${deadNeeded.join(", ")}); they will fail unless failover is configured.`);
    }
  } catch (preflightError) {
    if (preflightError && preflightError.code) throw preflightError;
    // Config load failure surfaces below with full context; do not mask it.
  }

  try {
    const result = await runPipeline(task, {
      repoRoot,
      dryRun: opts.dryRun,
      // Approval and cancellation options must reach the pipeline. They were
      // parsed by the CLI and then dropped here, so the documented
      // `run --approval-file` contract never fired: the extension sidebar's
      // Approve/Reject flow waited for a request that was never written, and a
      // non-TTY run refused every change for lack of a terminal.
      approvalFile: opts.approvalFile,
      approvalTimeoutMs: Number.isFinite(Number(opts.approvalTimeoutMs)) ? Number(opts.approvalTimeoutMs) : undefined,
      runId: typeof opts.runId === "string" ? opts.runId : undefined,
      signal: opts.signal,
      autoAccept: opts.autoAccept,
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

    // Check actual pipeline outcome — success requires at least one APPROVE
    const exitCode = result.success ? 0 : 1;
    return exitCode;
  } catch (e) {
    console.error(`Pipeline error: ${e.message}`);
    return 1;
  }
}

module.exports = { cmdRun };

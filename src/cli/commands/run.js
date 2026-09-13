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
    const preflightConfig = loadConfig(require("path").join(repoRoot, "minitok.yml"));
    const available = await detectAvailableProviders(preflightConfig);
    if (available.length === 0) {
      console.error("Error: No LLM provider is configured.\n");
      console.error("minitok needs one API key before it can run. Pick one:");
      console.error("  $env:ANTHROPIC_API_KEY='sk-ant-...'   # Claude");
      console.error("  $env:OPENAI_API_KEY='sk-...'          # GPT");
      console.error("  $env:GEMINI_API_KEY='...'             # Gemini");
      console.error("  $env:OPENROUTER_API_KEY='sk-or-...'   # OpenRouter");
      console.error("");
      console.error("Or save a key persistently:  minitok auth login <anthropic|openai|google|openrouter>");
      console.error("Then verify with:  minitok doctor");
      return 1;
    }

    // Live-check credentials, then judge only the providers the roles actually
    // resolve to. Scope matters: a stale unrelated token (e.g. an old
    // ~/.minitok/tokens/anthropic.json) must not abort an OpenAI-only run — the
    // earlier "any rejected provider is fatal" rule made that configuration
    // completely unrunnable. Unrelated rejected keys are reported as a warning.
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
    for (const name of available) {
      health.set(name, await verifyCredentials(name, preflightConfig.providers?.[name] || {}));
    }
    const statusOf = (name) => {
      if (!available.includes(name)) return "absent";
      return (health.get(name) || {}).status === "invalid" ? "dead" : "ok";
    };
    const neededOk = needed.filter(name => statusOf(name) === "ok");
    const alternatives = available.filter(name => statusOf(name) === "ok" && !needed.includes(name));

    if (neededOk.length === 0) {
      console.error("Error: no usable LLM provider for the configured roles (401/403 on every candidate):\n");
      for (const name of needed) {
        const state = statusOf(name);
        const detail = state === "dead" ? (health.get(name) || {}).detail || "key rejected" : "no credentials configured";
        console.error(`  ${name}: ${detail}`);
      }
      if (alternatives.length > 0) {
        console.error(`\nWorking providers detected: ${alternatives.join(", ")}`);
        console.error(`Run with:  minitok run "<task>" --provider-override ${alternatives[0]}`);
        console.error(`Or set it permanently: change roles.*.provider / default_provider in minitok.yml`);
      }
      console.error("\nRenew the rejected key:  minitok auth login <provider>   (or set the provider environment variable)");
      console.error("Then confirm with:      minitok doctor --verify");
      return 1;
    }

    const deadUnrelated = available.filter(name => statusOf(name) === "dead" && !needed.includes(name));
    if (deadUnrelated.length > 0) {
      console.warn(`[warn] rejected provider(s) not used by the resolved roles: ${deadUnrelated.join(", ")} — continuing with ${neededOk.join(", ")}`);
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

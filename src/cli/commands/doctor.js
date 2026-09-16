"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const { minitokVersion } = require("../../core/version");
const { detectAvailableProviders } = require("../../llm/provider");
const { loadConfig, resolveProviderName } = require("../../config/loader");
const { normalizeProvider } = require("../../auth/aliases");
const { checkEntitlement, GateState } = require("../../entitlement/gate");
const { loadInstallationRecord } = require("../../entitlement/online");

function check(name, ok, detail = "") {
  const marker = ok ? "[ok]" : "[error]";
  console.log(`  ${marker} ${name}${detail ? " — " + detail : ""}`);
  return ok;
}

function buildProviderChecks(config = {}) {
  const providerChecks = [
    ["Anthropic", "anthropic", "ANTHROPIC_API_KEY"],
    ["OpenAI", "openai", "OPENAI_API_KEY"],
    ["Google", "google", "GOOGLE_API_KEY"],
  ].map(([label, key, envVar]) => ({
    label,
    key,
    providerName: key,
    envVar,
    config: config.providers?.[key] || Object.entries(config.providers || {}).find(([name]) => normalizeProvider(name) === key)?.[1] || {},
    custom: false,
  }));
  const firstClass = new Set(providerChecks.map(provider => provider.key));
  for (const [providerName, providerConfig] of Object.entries(config.providers || {})) {
    const key = normalizeProvider(providerName);
    if (firstClass.has(key)) continue;
    providerChecks.push({
      label: `Custom provider ${providerName}`,
      key,
      providerName,
      envVar: null,
      config: providerConfig || {},
      custom: true,
    });
  }
  return providerChecks;
}

async function cmdDoctor(opts = {}) {
  console.log(`minitok ${minitokVersion} — Environment Check\n`);

  let allOk;

  // Node.js version
  const nodeVersion = process.version;
  const [major, minor] = nodeVersion.slice(1).split(".").map(Number);
  allOk = check("Node.js", major > 22 || (major === 22 && minor >= 19) || major >= 24, `${nodeVersion} (requires >=22.19.0)`);

  // npm
  try {
    const npmVer = execSync("npm --version", { encoding: "utf-8", timeout: 5000 }).trim();
    allOk = check("npm", true, npmVer) && allOk;
  } catch {
    allOk = check("npm", false, "not found") && allOk;
  }

  // git
  try {
    const gitVer = execSync("git --version", { encoding: "utf-8", timeout: 5000 }).trim();
    allOk = check("git", true, gitVer.replace("git version ", "")) && allOk;
  } catch {
    allOk = check("git", false, "not found") && allOk;
  }

  // ~/.minitok
  const minitokHome = require("path").join(os.homedir(), ".minitok");
  allOk = check("~/.minitok directory", fs.existsSync(minitokHome), minitokHome) && allOk;

  // Entitlement — surface the most common paid-product support issue in the
  // environment check instead of requiring customers to discover `status`.
  const entitlement = checkEntitlement();
  const installation = loadInstallationRecord();
  const entitlementDetail = entitlement.state === GateState.ALLOWED
    ? (installation ? "valid; installation token present" : "valid; online validation may be unavailable")
    : entitlement.message;
  allOk = check("Entitlement", entitlement.allowed, `${entitlement.state}: ${entitlementDetail}`) && allOk;

  // Config
  const config = loadConfig();
  const providers = await detectAvailableProviders(config);

  // LLM providers — informational per-provider; the overall check requires
  // at least one configured provider (most customers use exactly one).
  console.log("\nLLM Providers:");
  const providerChecks = buildProviderChecks(config);
  for (const provider of providerChecks) {
    const available = providers.includes(provider.key);
    const detail = provider.custom
      ? (available ? `configured (${provider.config.base_url || provider.config.endpoint || "custom endpoint"})` : "endpoint unavailable")
      : (available ? "configured" : `${provider.envVar} not set`);
    check(`  ${provider.label}`, available, detail);
  }

  // --verify: live credential check (detects expired/revoked keys that
  // presence checks cannot). This includes configured custom endpoints.
  if (opts && opts.verify) {
    const { verifyCredentials } = require("../../llm/provider");
    console.log("\nLive credential check:");
    for (const provider of providerChecks) {
      if (!provider.custom && !providers.includes(provider.key)) {
        check(`  ${provider.label} (live)`, false, `${provider.envVar} not set - skipped`);
        continue;
      }
      const v = await verifyCredentials(provider.providerName, provider.config);
      if (v.status === "ok" || v.status === "skipped") {
        check(`  ${provider.label} (live)`, true, v.status === "skipped" ? v.detail : "verified");
      } else {
        const reason = provider.custom
          ? { absent: "custom endpoint or credentials missing", invalid: `${v.detail} - check the provider configuration`, network_error: "unreachable - " + v.detail, error: v.detail }[v.status] || v.detail
          : { absent: "no key found", invalid: `${v.detail} - renew with: minitok auth login ${provider.key}`, network_error: "unreachable - " + v.detail, error: v.detail }[v.status] || v.detail;
        check(`  ${provider.label} (live)`, false, reason);
        allOk = false;
      }
    }
  }
  const anyProvider = providers.length > 0;
  allOk = check("LLM provider configured", anyProvider, anyProvider ? `using: ${providers.join(", ")}` : "set at least one provider API key (or configure a custom provider)") && allOk;

  console.log(`\nRoles:`);
  for (const [role, cfg] of Object.entries(config.roles)) {
    const providerName = resolveProviderName(config, role);
    const availableProviderName = normalizeProvider(providerName);
    const providerConfig = config.providers?.[availableProviderName] || config.providers?.[providerName] || {};
    const providerOk = providers.includes(availableProviderName) || cfg.adapter === "mock";
    const detail = providerOk
      ? `provider=${providerName}`
      : `provider=${providerName || "unset"}; configure roles.${role}.provider, default_provider, or a provider API key`;
    allOk = check(`  ${role}`, providerOk, detail) && allOk;
    if (providerOk && providerName && !providerConfig.models?.length && cfg.model) {
      check(`  ${role} model`, true, `${cfg.model} (provider default)`);
    }
  }

  console.log(`\n${allOk ? "[ok] All checks passed" : "[error] Some checks failed — see above"}`);
  if (!allOk) {
    console.log("\nNext steps:");
    if (!fs.existsSync(minitokHome)) console.log("  1. Run: minitok migrate");
    if (!entitlement.allowed) console.log("  2. Activate: minitok activate <activation-key>");
    if (!anyProvider) console.log("  3. Configure a provider API key or a custom provider in minitok.yml");
    console.log("  Run minitok doctor again after applying the fixes.");
  }
  return allOk ? 0 : 1;
}

module.exports = { cmdDoctor, buildProviderChecks };

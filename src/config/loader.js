"use strict";

/**
 * Config loader — loads and validates minitok.yml.
 * Priority: defaults → global → local → env vars → CLI overrides.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const yaml = require("js-yaml");
const { ConfigError } = require("../core/errors");
const { normalizeProvider } = require("../auth/aliases");
const { EXECUTION_POLICY_MODES } = require("../goal/execution_policy");
const { EXECUTION_CAPABILITIES, GENERAL_CAPABILITIES, isAlwaysBlockedCapability } = require("../goal/capabilities");
const { CAMELSTREAM_PROVIDER, camelstreamPreset } = require("../llm/camelstream");

const ENV_ALLOWLIST = new Set([
  "minitok_offline", "minitok_default_provider", "minitok_model", "minitok_server_url",
  "minitok_plan_provider", "minitok_plan_model", "minitok_review_provider", "minitok_review_model",
  "minitok_work_provider", "minitok_work_model", "minitok_intel_provider", "minitok_intel_model",
  "minitok_project_name", "minitok_project_stack", "minitok_goal_default_mode", "minitok_goal_unrestricted_enabled", "minitok_goal_unrestricted_require_explicit_confirmation", "minitok_goal_unrestricted_require_auto_accept", "minitok_goal_unrestricted_capabilities", "minitok_goal_unrestricted_general_enabled", "minitok_goal_unrestricted_general_require_explicit_confirmation", "minitok_goal_unrestricted_general_require_auto_accept", "minitok_goal_unrestricted_general_capabilities", "minitok_goal_unrestricted_general_max_plan_depth", "minitok_goal_unrestricted_general_max_replan_count", "minitok_goal_unrestricted_general_max_assumption_count",
  "minitok_budget_max_cycles", "minitok_budget_token_budget", "minitok_budget_max_cycles_hard_limit",
  "minitok_budget_token_hard_limit", "minitok_budget_stagnation_limit",
  "minitok_execution_max_retries", "minitok_execution_timeout_sec", "minitok_execution_retry_hard_limit",
  "minitok_execution_timeout_hard_limit_sec", "minitok_execution_retry_backoff_sec", "minitok_execution_retry_max_sec",
  "minitok_execution_research_enabled", "minitok_validation_enabled", "minitok_validation_script_path",
  "minitok_validation_timeout_ms", "minitok_validation_confidence_threshold", "minitok_validation_max_changed_files",
]);
const _ROLE_KEYS = new Set(["plan", "review", "work", "intel"]);

const DEFAULTS = {
  offline: false,
  default_provider: "",
  project: { name: "unknown", stack: "generic" },
  goal: {
    default_mode: "safe",
    unrestricted: { enabled: false, require_explicit_confirmation: true, require_auto_accept: true, capabilities: [] },
    unrestricted_general: { enabled: false, require_explicit_confirmation: true, require_auto_accept: true, allow_goal_inference: true, allow_provisional_criteria: true, allow_replanning: true, allow_tool_discovery: true, allow_external_adapters: false, capabilities: [], max_plan_depth: 50, max_replan_count: 20, max_assumption_count: 100 },
  },
  roles: {
    plan: { provider: "", adapter: "claude", model: "", effort: "medium", reasoning: null, thinking_budget: 0, fallback_model: "", fallback: [], timeout_sec: 300 },
    review: { provider: "", adapter: "claude", model: "", effort: "medium", reasoning: null, thinking_budget: 0, fallback_model: "", fallback: [], timeout_sec: 300 },
    work: { provider: "", adapter: "claude", model: "", effort: "medium", reasoning: null, thinking_budget: 0, fallback_model: "", fallback: [], timeout_sec: 300 },
    intel: { provider: "", adapter: "claude", model: "", effort: "medium", reasoning: null, thinking_budget: 0, fallback_model: "", fallback: [], timeout_sec: 300 },
  },
  budget: {
    max_cycles: "unlimited",
    token_budget: "unlimited",
    max_cycles_hard_limit: 100,
    token_hard_limit: 2000000,
    stagnation_limit: 3,
  },
  execution: {
    max_retries: "unlimited",
    timeout_sec: "unlimited",
    retry_hard_limit: 5,
    timeout_hard_limit_sec: 86400,
    retry_backoff_sec: 90.0,
    retry_max_sec: 1800.0,
    research_enabled: true,
  },
  validation: { enabled: true, script_path: "VERIFY_CMD.mjs", timeout_ms: 120000, confidence_threshold: 0.8, max_changed_files: 20 },
  security: { blocked_extensions: [".env", ".pem", ".key", ".p12", ".pfx"] },
};

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const result = Object.assign(Object.create(null), base || {});
  for (const [key, value] of Object.entries(override)) {
    if (FORBIDDEN_KEYS.has(key)) throw new ConfigError(`Forbidden configuration key: ${key}`);
    if (Object.prototype.hasOwnProperty.call(result, key) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key]) && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Safely coerce a string value to its native type.
 * Handles null/undefined/empty to prevent TypeError.
 */
function coerceValue(value) {
  if (value == null || value === "") return null;
  const s = String(value);
  if (["true", "yes", "1"].includes(s.toLowerCase())) return true;
  if (["false", "no", "0"].includes(s.toLowerCase())) return false;
  const int = parseInt(s, 10);
  if (!isNaN(int) && String(int) === s) return int;
  const float = parseFloat(s);
  if (!isNaN(float) && String(float) === s) return float;
  return s;
}

function loadEnvVars() {
  const result = {};
  const envPaths = {
    offline: ["offline"],
    default_provider: ["default_provider"],
    model: ["model"],
    plan_provider: ["plan", "provider"],
    plan_model: ["plan", "model"],
    review_provider: ["review", "provider"],
    review_model: ["review", "model"],
    work_provider: ["work", "provider"],
    work_model: ["work", "model"],
    intel_provider: ["intel", "provider"],
    intel_model: ["intel", "model"],
    project_name: ["project", "name"],
    project_stack: ["project", "stack"],
    goal_default_mode: ["goal", "default_mode"],
    goal_unrestricted_enabled: ["goal", "unrestricted", "enabled"],
    goal_unrestricted_require_explicit_confirmation: ["goal", "unrestricted", "require_explicit_confirmation"],
    goal_unrestricted_require_auto_accept: ["goal", "unrestricted", "require_auto_accept"],
    goal_unrestricted_capabilities: ["goal", "unrestricted", "capabilities"],
    goal_unrestricted_general_enabled: ["goal", "unrestricted_general", "enabled"],
    goal_unrestricted_general_require_explicit_confirmation: ["goal", "unrestricted_general", "require_explicit_confirmation"],
    goal_unrestricted_general_require_auto_accept: ["goal", "unrestricted_general", "require_auto_accept"],
    goal_unrestricted_general_capabilities: ["goal", "unrestricted_general", "capabilities"],
    goal_unrestricted_general_max_plan_depth: ["goal", "unrestricted_general", "max_plan_depth"],
    goal_unrestricted_general_max_replan_count: ["goal", "unrestricted_general", "max_replan_count"],
    goal_unrestricted_general_max_assumption_count: ["goal", "unrestricted_general", "max_assumption_count"],
    budget_max_cycles: ["budget", "max_cycles"],
    budget_token_budget: ["budget", "token_budget"],
    budget_max_cycles_hard_limit: ["budget", "max_cycles_hard_limit"],
    budget_token_hard_limit: ["budget", "token_hard_limit"],
    budget_stagnation_limit: ["budget", "stagnation_limit"],
    execution_max_retries: ["execution", "max_retries"],
    execution_timeout_sec: ["execution", "timeout_sec"],
    execution_retry_hard_limit: ["execution", "retry_hard_limit"],
    execution_timeout_hard_limit_sec: ["execution", "timeout_hard_limit_sec"],
    execution_retry_backoff_sec: ["execution", "retry_backoff_sec"],
    execution_retry_max_sec: ["execution", "retry_max_sec"],
    execution_research_enabled: ["execution", "research_enabled"],
    validation_enabled: ["validation", "enabled"],
    validation_script_path: ["validation", "script_path"],
    validation_timeout_ms: ["validation", "timeout_ms"],
    validation_confidence_threshold: ["validation", "confidence_threshold"],
    validation_max_changed_files: ["validation", "max_changed_files"],
  };
  for (const [key, value] of Object.entries(process.env)) {
    const normalizedKey = key.toLowerCase();
    if (!ENV_ALLOWLIST.has(normalizedKey)) continue;
    const configKey = normalizedKey.slice("minitok_".length);
    const parts = envPaths[configKey] || [configKey];
    let nested = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!nested[parts[i]] || typeof nested[parts[i]] !== "object") nested[parts[i]] = {};
      nested = nested[parts[i]];
    }
    nested[parts[parts.length - 1]] = parts.at(-1) === "capabilities" ? String(value).split(",").map(item => item.trim()).filter(Boolean) : coerceValue(value);

    if (_ROLE_KEYS.has(parts[0])) {
      if (!result.roles) result.roles = {};
      const roleNested = {};
      let cur = roleNested;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = coerceValue(value);
      result.roles = deepMerge(result.roles, roleNested);
    }
  }
  return result;
}

function loadYaml(filePath) {
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    // Use safe schema to prevent YAML code execution attacks (!!js/function etc.)
    const parsed = yaml.load(data, { schema: yaml.DEFAULT_SAFE_SCHEMA });
    if (parsed == null) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new ConfigError("Configuration root must be a mapping");
    deepMerge({}, parsed);
    return parsed;
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new ConfigError(`Invalid YAML in ${filePath}: ${e.message}`);
  }
}

function resolveProviderName(config, role, override) {
  const providers = config?.providers || {};
  const roleConfig = config?.roles?.[role] || {};
  // Priority: explicit override > role provider > explicit default_provider
  // > configured legacy adapter > first configured provider. A default adapter
  // from the built-in defaults must not hide the only provider the user added.
  if (override || roleConfig.provider || config?.default_provider) return override || roleConfig.provider || config.default_provider;
  const configuredAdapter = typeof roleConfig.adapter === "string" && Object.prototype.hasOwnProperty.call(providers, roleConfig.adapter) ? roleConfig.adapter : "";
  return configuredAdapter || Object.keys(providers)[0] || roleConfig.adapter || "";
}

// Provider names reach storage paths, keychain commands and shell arguments.
// Nothing legitimate needs quotes, backticks or statement separators, so reject
// them at the configuration boundary in addition to escaping every call site.
const UNSAFE_PROVIDER_NAME_PATTERN = /['"`$;|&()<>\r\n\t\\]|\.\./;

function assertSafeProviderName(name, label) {
  if (typeof name !== "string" || !name.trim()) return; // unset values fall through to the next source
  if (UNSAFE_PROVIDER_NAME_PATTERN.test(name)) throw new ConfigError(`${label} ${JSON.stringify(name.slice(0, 40))} contains characters that are not allowed in a provider name`);
}

function normalizeProviderConfig(config) {
  if (!config || typeof config !== "object") return config;
  if (config.providers && typeof config.providers === "object" && !Array.isArray(config.providers)) {
    const providers = Object.create(null);
    const aliases = [];
    for (const [name, value] of Object.entries(config.providers)) {
      const canonical = normalizeProvider(name);
      if (canonical === CAMELSTREAM_PROVIDER) providers[canonical] = camelstreamPreset(value || {});
      else if (canonical === name.toLowerCase()) providers[canonical] = value;
      else aliases.push([canonical, value]);
    }
    // A canonical key is authoritative when both `gpt` and `openai` exist.
    for (const [canonical, value] of aliases) if (!Object.prototype.hasOwnProperty.call(providers, canonical)) providers[canonical] = value;
    config.providers = providers;
  }
  for (const role of Object.values(config.roles || {})) {
    if (!role || typeof role !== "object") continue;
    // `provider` selects a configured provider and is canonicalized. `adapter` is
    // a legacy display/fallback field; preserve aliases such as `claude` there so
    // generated configs and existing callers keep their established contract.
    if (typeof role.provider === "string" && role.provider.trim()) role.provider = normalizeProvider(role.provider);
  }
  if (typeof config.default_provider === "string" && config.default_provider.trim()) config.default_provider = normalizeProvider(config.default_provider);
  return config;
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new ConfigError("Configuration must be a mapping");
  if (config.providers !== undefined && (typeof config.providers !== "object" || Array.isArray(config.providers))) throw new ConfigError("providers must be a mapping");
  if (config.providers) for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new ConfigError(`providers.${name} must be a mapping`);
    assertSafeProviderName(name, "providers key");
    if (provider.model !== undefined && (typeof provider.model !== "string" || !provider.model.trim())) throw new ConfigError(`providers.${name}.model must be a non-empty string`);
    if (provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.some(model => !model || typeof model !== "object" || typeof model.id !== "string" || !model.id.trim()))) throw new ConfigError(`providers.${name}.models must contain model objects with non-empty id`);
    // api_key_env has to name an environment variable: a typo here would
    // otherwise be ignored silently and leave the provider without credentials.
    if (provider.api_key_env !== undefined && (typeof provider.api_key_env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.api_key_env))) throw new ConfigError(`providers.${name}.api_key_env must name an environment variable`);
  }
  if (config.roles !== undefined && (typeof config.roles !== "object" || Array.isArray(config.roles))) throw new ConfigError("roles must be a mapping");
  for (const [role, value] of Object.entries(config.roles || {})) {
    if (!_ROLE_KEYS.has(role)) throw new ConfigError(`Unknown role '${role}'. Supported roles: ${[..._ROLE_KEYS].join(", ")}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`roles.${role} must be a mapping`);
    for (const key of ["provider", "model", "fallback_model"]) if (value[key] !== undefined && typeof value[key] !== "string") throw new ConfigError(`roles.${role}.${key} must be a string`);
    for (const key of ["provider", "adapter"]) assertSafeProviderName(value[key], `roles.${role}.${key}`);
  }
  if (config.default_provider !== undefined && config.default_provider !== null && typeof config.default_provider !== "string") throw new ConfigError("default_provider must be a string");
  assertSafeProviderName(config.default_provider, "default_provider");
  if (config.validation?.script_path !== undefined && typeof config.validation.script_path !== "string") throw new ConfigError("validation.script_path must be a string");
  if (config.security?.blocked_extensions !== undefined && (!Array.isArray(config.security.blocked_extensions) || config.security.blocked_extensions.some(value => typeof value !== "string"))) throw new ConfigError("security.blocked_extensions must be an array of strings");
  validateGoalExecutionConfig(config.goal);
  return config;
}

function validateGoalExecutionConfig(goal) {
  if (goal === undefined) return;
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) throw new ConfigError("goal must be a mapping");
  for (const key of Object.keys(goal)) if (!["default_mode", "unrestricted", "unrestricted_general"].includes(key)) throw new ConfigError(`Unknown goal configuration field: ${key}`);
  const allowedModes = EXECUTION_POLICY_MODES.filter(mode => mode !== "always_blocked");
  if (goal.default_mode !== undefined && !allowedModes.includes(goal.default_mode)) throw new ConfigError(`goal.default_mode must be one of: ${allowedModes.join(", ")}`);
  const unrestricted = goal.unrestricted;
  const unrestrictedGeneral = goal.unrestricted_general;
  if (unrestricted === undefined && unrestrictedGeneral === undefined) return;
  if (unrestricted !== undefined && (!unrestricted || typeof unrestricted !== "object" || Array.isArray(unrestricted))) throw new ConfigError("goal.unrestricted must be a mapping");
  if (unrestrictedGeneral !== undefined && (!unrestrictedGeneral || typeof unrestrictedGeneral !== "object" || Array.isArray(unrestrictedGeneral))) throw new ConfigError("goal.unrestricted_general must be a mapping");
  validateUnrestrictedPolicy(unrestricted, "goal.unrestricted", false);
  validateUnrestrictedPolicy(unrestrictedGeneral, "goal.unrestricted_general", true);
}

function validateUnrestrictedPolicy(policy, prefix, general) {
  if (policy === undefined) return;
  const common = ["enabled", "require_explicit_confirmation", "require_auto_accept", "capabilities"];
  const generalKeys = ["allow_goal_inference", "allow_provisional_criteria", "allow_replanning", "allow_tool_discovery", "allow_external_adapters", "max_plan_depth", "max_replan_count", "max_assumption_count"];
  const allowed = new Set(general ? [...common, ...generalKeys] : common);
  for (const key of Object.keys(policy)) if (!allowed.has(key)) throw new ConfigError(`Unknown ${prefix} configuration field: ${key}`);
  for (const key of ["enabled", "require_explicit_confirmation", "require_auto_accept", ...(general ? generalKeys.slice(0, 5) : [])]) if (policy[key] !== undefined && typeof policy[key] !== "boolean") throw new ConfigError(`${prefix}.${key} must be a boolean`);
  for (const key of general ? ["max_plan_depth", "max_replan_count", "max_assumption_count"] : []) if (policy[key] !== undefined && (!Number.isSafeInteger(policy[key]) || policy[key] < (key === "max_replan_count" ? 0 : 1))) throw new ConfigError(`${prefix}.${key} must be a positive safe integer`);
  if (policy.capabilities !== undefined) {
    if (!Array.isArray(policy.capabilities) || policy.capabilities.some(value => typeof value !== "string" || !value.trim())) throw new ConfigError(`${prefix}.capabilities must be an array of non-empty strings`);
    const duplicates = policy.capabilities.filter((value, index, values) => values.indexOf(value) !== index);
    if (duplicates.length) throw new ConfigError(`${prefix}.capabilities contains duplicate capability: ${duplicates[0]}`);
    for (const capability of policy.capabilities) {
      if (!EXECUTION_CAPABILITIES.includes(capability) && !(general && GENERAL_CAPABILITIES.includes(capability))) throw new ConfigError(`${prefix}.capabilities contains unknown capability: ${capability}`);
      if (isAlwaysBlockedCapability(capability)) throw new ConfigError(`${prefix}.capabilities cannot enable always-blocked capability: ${capability}`);
    }
  }
}

function redactGoalExecutionConfig(config = {}) {
  const goal = config.goal || DEFAULTS.goal;
  const unrestricted = goal.unrestricted || DEFAULTS.goal.unrestricted;
  const hasGeneralPolicy = Object.prototype.hasOwnProperty.call(goal, "unrestricted_general");
  const unrestrictedGeneral = goal.unrestricted_general || DEFAULTS.goal.unrestricted_general;
  const result = {
    default_mode: goal.default_mode || "safe",
    unrestricted: {
      enabled: unrestricted.enabled === true,
      require_explicit_confirmation: unrestricted.require_explicit_confirmation !== false,
      require_auto_accept: unrestricted.require_auto_accept !== false,
      capabilities: Array.isArray(unrestricted.capabilities) ? [...unrestricted.capabilities] : [],
    },
    unrestricted_general: {
      enabled: unrestrictedGeneral.enabled === true,
      require_explicit_confirmation: unrestrictedGeneral.require_explicit_confirmation !== false,
      require_auto_accept: unrestrictedGeneral.require_auto_accept !== false,
      allow_goal_inference: unrestrictedGeneral.allow_goal_inference === true,
      allow_provisional_criteria: unrestrictedGeneral.allow_provisional_criteria === true,
      allow_replanning: unrestrictedGeneral.allow_replanning === true,
      allow_tool_discovery: unrestrictedGeneral.allow_tool_discovery === true,
      allow_external_adapters: unrestrictedGeneral.allow_external_adapters === true,
      capabilities: Array.isArray(unrestrictedGeneral.capabilities) ? [...unrestrictedGeneral.capabilities] : [],
      max_plan_depth: unrestrictedGeneral.max_plan_depth,
      max_replan_count: unrestrictedGeneral.max_replan_count,
      max_assumption_count: unrestrictedGeneral.max_assumption_count,
    },
  };
  if (!hasGeneralPolicy) delete result.unrestricted_general;
  return result;
}

function globalConfigPaths() {
  const candidates = [];
  const xdg = String(process.env.XDG_CONFIG_HOME || "").trim();
  // Platform convention first. The previous hardcoded ~/.config path ignored
  // Windows (%APPDATA%) and $XDG_CONFIG_HOME entirely, so a "global" config was
  // silently not loaded there.
  if (xdg) candidates.push(path.join(xdg, "minitok", "config.yml"));
  else if (process.platform === "win32" && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "minitok", "config.yml"));
  else candidates.push(path.join(os.homedir(), ".config", "minitok", "config.yml"));
  // Keep the legacy location working, and honour the product directory that
  // every other minitok path already uses. Later entries win.
  candidates.push(path.join(os.homedir(), ".config", "minitok", "config.yml"));
  candidates.push(path.join(os.homedir(), ".minitok", "config.yml"));
  return [...new Set(candidates)].filter(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}

function loadConfig(configPath, overrides) {
  let raw = {};

  // 2. User global config (platform path, legacy path, then ~/.minitok).
  // A malformed global file is reported rather than ignored: silently dropping it
  // replaces every setting the user wrote with defaults and says nothing.
  for (const globalPath of globalConfigPaths()) raw = deepMerge(raw, loadYaml(globalPath));

  // 3. Project local config — resolve from explicit path, then repoRoot, then CWD
  const candidates = [
    configPath,
    path.join(overrides?.repoRoot || process.cwd(), "minitok.yml"),
    "minitok.yml",
  ].filter(Boolean);
  let resolved = false;
  for (const candidate of candidates) {
    if (resolved) break;
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch (error) {
      // A missing candidate is the normal case (no project config yet). Anything
      // else — a permission failure, a path component that is a file — used to be
      // swallowed together with it and must be reported now.
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw new ConfigError(`Unable to read configuration ${candidate}: ${error.message}`);
    }
    if (!stat.isFile()) continue;
    // loadYaml already names the file and the parse failure in its ConfigError.
    raw = deepMerge(raw, loadYaml(candidate));
    resolved = true;
  }

  // 4. Environment variables
  raw = deepMerge(raw, loadEnvVars());

  // 5. CLI overrides
  if (overrides) raw = deepMerge(raw, overrides);

  // Merge with defaults
  const config = normalizeProviderConfig(deepMerge(DEFAULTS, raw));
  return validateConfig(config);
}

module.exports = { loadConfig, deepMerge, coerceValue, resolveProviderName, validateConfig, validateGoalExecutionConfig, redactGoalExecutionConfig, normalizeProviderConfig, DEFAULTS };

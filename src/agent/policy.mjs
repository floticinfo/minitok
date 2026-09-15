export const MINITOK_MODE = Object.freeze({ ON: "on", OFF: "off" });
export const ALLOWED_TOOL_PREFIX = "minitok_";

export function resolveMode(value = process.env.MINITOK_MODE ?? MINITOK_MODE.ON) {
  const mode = String(value).trim().toLowerCase();
  if (mode !== MINITOK_MODE.ON && mode !== MINITOK_MODE.OFF) {
    throw new Error(`Invalid minitok mode: ${value}. Expected "on" or "off".`);
  }
  return mode;
}

export function assertModeEnabled(mode) {
  if (resolveMode(mode) === MINITOK_MODE.OFF) {
    throw Object.assign(new Error("minitok is OFF: no agent task was executed. Enable --mode on or MINITOK_MODE=on to use the minitok pipeline."), { code: "MINITOK_MODE_OFF" });
  }
}

export function isAllowedTool(name) {
  return typeof name === "string" && name.startsWith(ALLOWED_TOOL_PREFIX);
}

export function filterMinitokTools(tools) {
  return (Array.isArray(tools) ? tools : []).filter(tool => isAllowedTool(tool?.name));
}

export function requireAbsoluteRepo(repo, fallback = process.cwd()) {
  const value = repo ?? fallback;
  if (typeof value !== "string" || !value) throw new Error("A repository path is required.");
  if (!isAbsolutePath(value)) throw new Error("The repository path must be absolute.");
  return value;
}

export function normalizeRunInput(input, cwd = process.cwd(), { allowAutoAccept = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("minitok_run input must be an object.");
  if (typeof input.task !== "string" || !input.task.trim()) throw new Error("minitok_run requires a non-empty task.");
  return {
    ...input,
    repo: requireAbsoluteRepo(input.repo, cwd),
    auto_accept: allowAutoAccept && input.auto_accept === true,
  };
}

function isAbsolutePath(value) {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export function isReadOnlyTool(name) {
  return name === "minitok_status" || name === "minitok_run_list" || name === "minitok_run_get" || name === "minitok_knowledge_query";
}

export function buildSystemPrompt(mode) {
  assertModeEnabled(mode);
  return [
    "You are a minitok-only coding host.",
    "Never edit files, run shell commands, or implement repository changes directly.",
    "For every repository-changing request, call minitok_run.",
    "Use an absolute repository path in the repo argument.",
    "auto_accept is false unless the user explicitly requests automatic acceptance.",
    "Use minitok_status or minitok_run_list for inspection.",
    "Report the minitok run_id and verification outcome after execution.",
  ].join("\n");
}

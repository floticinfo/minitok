"use strict";

const fs = require("fs");
const path = require("path");
const { runPipeline } = require("../pipeline/loop");

const MCP_ERROR_CODES = Object.freeze({ INVALID_PARAMS: -32602, AUTH_REQUIRED: -32001, PERMISSION_DENIED: -32003, NOT_FOUND: -32004, RUN_LIMIT_REACHED: -32005, TOOL_ERROR: -32000 });

/**
 * Colour policy for the MCP surface.
 *
 * MCP is the one product surface that must stay colour-free. Every response is
 * JSON-RPC that the host renders -- `content[].text` is inserted into the
 * client's own transcript, often through a pager, a log file or a CI capture --
 * so a sequence from `src/core/palette.js` would be displayed literally as
 * `\x1b[38;2;...m` instead of being interpreted. Nothing here imports the
 * palette module: brand identity reaches this surface through the tool names,
 * the descriptions and the structured payload, and the host applies its own
 * theme to the result.
 *
 * The same rule applies to the runtime resources and prompts in
 * `src/runtime/stdio.js` (`minitok://status`, `minitok://runs`,
 * `minitok_task`): they are data, not decoration.
 */
const TOOLS = [
  { name: "minitok_run_list", description: "List minitok runs", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "minitok_run_get", description: "Get a minitok run by run_id", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { run_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["run_id"], additionalProperties: false } },
  { name: "minitok_run_cancel", description: "Cancel an active minitok run", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { run_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["run_id"], additionalProperties: false } },
{ name: "minitok_approve_run", description: "Approve a pending minitok change request", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { approval_file: { type: "string", minLength: 1, maxLength: 4096 }, nonce: { type: "string", minLength: 16, maxLength: 128 }, run_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["approval_file", "nonce", "run_id"], additionalProperties: false } },
   { name: "minitok_reject_run", description: "Reject a pending minitok change request", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { approval_file: { type: "string", minLength: 1, maxLength: 4096 }, nonce: { type: "string", minLength: 16, maxLength: 128 }, run_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["approval_file", "nonce", "run_id"], additionalProperties: false } },
  { name: "minitok_run", description: "Run the minitok pipeline; repository changes require approval unless an explicitly permitted policy allows auto_accept.", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { run_id: { type: "string", minLength: 1, maxLength: 128 }, task: { type: "string", minLength: 1, maxLength: 20000 }, repo: { type: "string", minLength: 1, maxLength: 4096 }, workspace: { type: "string", minLength: 1, maxLength: 256 }, dry_run: { type: "boolean" }, auto_accept: { type: "boolean" }, provider_override: { type: "string", minLength: 1, maxLength: 256 }, approval_file: { type: "string", minLength: 1, maxLength: 4096 }, approval_timeout_ms: { type: "integer", minimum: 1000, maximum: 3600000 } }, required: ["task"], additionalProperties: false } },
  { name: "minitok_knowledge_query", description: "Query past minitok outcomes", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 0, maximum: 1000 }, project: { type: "string", maxLength: 4096 } }, additionalProperties: false } },
  { name: "minitok_knowledge_record", description: "Record an evolution outcome", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { goal: { type: "string", minLength: 1, maxLength: 2000 }, status: { type: "string", enum: ["success", "failure", "partial"] }, cycles: { type: "integer", minimum: 0, maximum: 10000 }, summary: { type: "string", maxLength: 20000 } }, required: ["goal", "status"], additionalProperties: false } },
  { name: "minitok_analyze_failures", description: "Analyze failure patterns", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { project: { type: "string", minLength: 1, maxLength: 4096 } }, additionalProperties: false } },
  { name: "minitok_recommend_policy", description: "Get execution policy recommendations", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { project: { type: "string", minLength: 1, maxLength: 4096 }, current_policy: { type: "object", additionalProperties: false, properties: { max_cycles: { type: "integer", minimum: 0, maximum: 10000 } } } }, additionalProperties: false } },
  { name: "minitok_compact_context", description: "Compact text to fit a token budget", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 1000000 }, budget_chars: { type: "integer", minimum: 100, maximum: 1000000 } }, required: ["text"], additionalProperties: false } },
  { name: "minitok_collect_evidence", description: "Collect project evidence", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { project: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["project"], additionalProperties: false } },
  { name: "minitok_status", description: "Show minitok status", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "minitok_observe", description: "Submit redacted observation events", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { project: { type: "string", maxLength: 4096 }, events: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: true } } }, required: ["events"], additionalProperties: false } },
];

/**
 * Explicit scope requirements.
 *
 * The gate must not be derived from `annotations.destructiveHint`: MCP
 * annotations describe whether a tool may perform *destructive* updates, and
 * `minitok_knowledge_record` and `minitok_observe` are annotated as
 * non-destructive because they only append. Both persist to the user's home
 * directory though, so `read` would not mean read-only if destructiveHint were
 * the only signal. Every tool that writes anything therefore needs `write`.
 */
const TOOL_SCOPES = Object.freeze({
  minitok_run: "write",
  minitok_run_cancel: "write",
  minitok_approve_run: "write",
  minitok_reject_run: "write",
  minitok_knowledge_record: "write",
  minitok_observe: "write",
});
function requiredScopeFor(name) { return TOOL_SCOPES[name] || "read"; }

// Running the pipeline executes the repository's own verification script
// (validation.script_path / VERIFY_CMD.*) with the operator's account, so an MCP
// client needs an explicit grant in addition to `write`: a repository the agent
// can point at must not be able to run code merely because the client may write
// files. `minitok_run` therefore also requires the `verify_exec` scope.
const TOOL_EXTRA_SCOPES = Object.freeze({ minitok_run: ["verify_exec"] });
function requiredExtraScopesFor(name) { return TOOL_EXTRA_SCOPES[name] || []; }

function getToolDefinitions() { return TOOLS; }
function canonical(value) { return fs.realpathSync.native(path.resolve(value)); }
function sameOrUnder(candidate, root) {
  const a = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const b = process.platform === "win32" ? root.toLowerCase() : root;
  return a === b || a.startsWith(`${b}${path.sep}`);
}
function requireWorkspacePath(value, root, field) {
  if (!path.isAbsolute(value)) throw Object.assign(new Error(`${field} must be an absolute path`), { code: "INVALID_PATH" });
  let candidate;
  try { candidate = canonical(value); } catch { throw Object.assign(new Error(`${field} does not exist`), { code: "INVALID_PATH" }); }
  const workspace = canonical(root);
  if (!sameOrUnder(candidate, workspace)) throw Object.assign(new Error(`${field} is outside the MCP workspace`), { code: "PATH_OUTSIDE_WORKSPACE" });
  return candidate;
}
function requireApprovalPath(value, root) {
  if (!path.isAbsolute(value)) throw Object.assign(new Error("approval_file must be an absolute path"), { code: "INVALID_PATH" });
  const workspace = canonical(root);
  const approvalRoot = path.join(workspace, ".minitok");
  const candidate = path.resolve(value);
  const parent = path.dirname(candidate);
  let canonicalParent;
  try { canonicalParent = canonical(parent); } catch { throw Object.assign(new Error("approval_file parent does not exist"), { code: "INVALID_PATH" }); }
  if (!sameOrUnder(canonicalParent, approvalRoot) || path.basename(candidate).includes("..")) throw Object.assign(new Error("approval_file must be under workspace/.minitok"), { code: "PATH_OUTSIDE_WORKSPACE" });
  return path.join(canonicalParent, path.basename(candidate));
}
function validateSchema(value, schema, name) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error(`${name} must be an object`), { code: "INVALID_PARAMS" });
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false && !schema.properties?.[key]) throw Object.assign(new Error(`Unknown argument: ${name}.${key}`), { code: "INVALID_PARAMS" });
      if (schema.properties?.[key]) validateSchema(value[key], schema.properties[key], `${name}.${key}`);
    }
    for (const key of schema.required || []) if (value[key] === undefined) throw Object.assign(new Error(`${name}.${key} is required`), { code: "INVALID_PARAMS" });
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw Object.assign(new Error(`${name} must be an array`), { code: "INVALID_PARAMS" });
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) throw Object.assign(new Error(`${name} is out of range`), { code: "INVALID_PARAMS" });
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${name}[${index}]`));
  } else {
    if (schema.type === "integer" ? !Number.isInteger(value) : typeof value !== schema.type) throw Object.assign(new Error(`${name} must be ${schema.type}`), { code: "INVALID_PARAMS" });
    if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw Object.assign(new Error(`${name} is out of range`), { code: "INVALID_PARAMS" });
    if (schema.enum && !schema.enum.includes(value)) throw Object.assign(new Error(`${name} is invalid`), { code: "INVALID_PARAMS" });
  }
}
function validateArgs(name, args) {
  const definition = TOOLS.find(tool => tool.name === name);
  if (!definition) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: "TOOL_NOT_FOUND" });
  const input = { ...args };
  // Only tools that declare run_id may receive one. The transport injects a
  // server-generated id for minitok_run; everywhere else a caller-supplied
  // run_id would be an undeclared argument.
  if (!definition.inputSchema.properties?.run_id) delete input.run_id;
  validateSchema(input, definition.inputSchema, "arguments");
  // Return the validated copy rather than the original arguments so a field the
  // schema rejected is not reachable from the handler.
  return input;
}
/**
 * stdout is the JSON-RPC channel for the stdio transport, so pipeline logging
 * must be diverted to stderr while minitok_run executes. The redirect has to be
 * reference counted: with two overlapping runs the first completion would
 * otherwise restore the original console while the second is still logging,
 * leaking raw pipeline output onto the JSON-RPC stream.
 */
const STDOUT_GUARD = { depth: 0, original: null };
function acquireStdoutGuard() {
  if (STDOUT_GUARD.depth === 0) {
    STDOUT_GUARD.original = { log: console.log, info: console.info, warn: console.warn };
    const toStderr = console.error;
    console.log = (...values) => toStderr(...values);
    console.info = (...values) => toStderr(...values);
    console.warn = (...values) => toStderr(...values);
  }
  STDOUT_GUARD.depth += 1;
}
function releaseStdoutGuard() {
  if (STDOUT_GUARD.depth === 0) return;
  STDOUT_GUARD.depth -= 1;
  if (STDOUT_GUARD.depth > 0) return;
  const original = STDOUT_GUARD.original;
  STDOUT_GUARD.original = null;
  if (!original) return;
  console.log = original.log;
  console.info = original.info;
  console.warn = original.warn;
}
async function _getToolHandler(name, args, services, runtimeOptions = {}) {
  // Handlers must only observe validated arguments, so adopt the sanitized copy.
  // Previously the validated copy was discarded and the original object was used,
  // which made the run_id rule below unreachable.
  args = validateArgs(name, args);
  if (name === "minitok_run_list") return { content: [{ type: "text", text: JSON.stringify([...(runtimeOptions.recoveredRuns || []).map(run => ({ run_id: run.run_id, state: run.state, recovery: run.recovery || undefined })), ...[...runtimeOptions.runs?.values?.() || []].map(run => ({ run_id: run.runId, state: run.state || (run.controller.signal.aborted ? "cancelled" : "running"), persistence: run.persistence || runtimeOptions.persistence || null }))]) }] };
  if (name === "minitok_run_get") { const run = runtimeOptions.runs?.get?.(args.run_id) || (runtimeOptions.recoveredRuns || []).find(item => item.run_id === args.run_id); if (!run) throw Object.assign(new Error("Run not found"), { code: "RUN_NOT_FOUND" }); return { content: [{ type: "text", text: JSON.stringify({ run_id: run.runId || run.run_id, state: run.state || "unknown", recovery: run.recovery || undefined, persistence: run.persistence || runtimeOptions.persistence || null }) }] }; }
  if (name === "minitok_run_cancel") { const run = runtimeOptions.runs?.get?.(args.run_id); if (!run) throw Object.assign(new Error("Run not found"), { code: "RUN_NOT_FOUND" }); run.controller.abort(); run.state = "cancelled"; return { content: [{ type: "text", text: JSON.stringify({ run_id: args.run_id, state: "cancelled" }) }] }; }
  if (["minitok_approve_run", "minitok_reject_run"].includes(name)) { const approvalFile = requireApprovalPath(args.approval_file, runtimeOptions.workspaceRoot || process.cwd()); if (typeof runtimeOptions.writeApproval !== "function") throw Object.assign(new Error("Approval transport unavailable"), { code: "APPROVAL_UNAVAILABLE" }); const decision = name === "minitok_approve_run" ? "approve" : "reject"; runtimeOptions.writeApproval(approvalFile, decision, { nonce: args.nonce, runId: args.run_id }); return { content: [{ type: "text", text: JSON.stringify({ decision, approval_file: approvalFile }) }] }; }
  switch (name) {
    case "minitok_run": {
      let repoRoot = args.repo;
      if (!repoRoot && args.workspace) { const { WorkspaceManager } = require("../workspace/manager"); repoRoot = new WorkspaceManager().resolve(args.workspace).repository_root; }
      repoRoot = requireWorkspacePath(repoRoot || process.cwd(), runtimeOptions.workspaceRoot || process.cwd(), "repo");
      if (args.auto_accept && !runtimeOptions.permissions?.has?.("auto_accept")) throw Object.assign(new Error("auto_accept requires explicit auto_accept permission"), { code: "AUTO_ACCEPT_DENIED" });
      const approvalFile = args.approval_file ? requireApprovalPath(args.approval_file, runtimeOptions.workspaceRoot || process.cwd()) : undefined;
      const pipelineRunner = runtimeOptions.runPipeline || runPipeline;
      acquireStdoutGuard();
      let result;
      try {
        result = await pipelineRunner(args.task, { runId: args.run_id, repoRoot, dryRun: args.dry_run === true, autoAccept: args.auto_accept === true && runtimeOptions.permissions?.has?.("auto_accept"), providerOverride: args.provider_override, approvalFile, approvalTimeoutMs: args.approval_timeout_ms, signal: runtimeOptions.signal, onProgress: runtimeOptions.onProgress });
      } finally {
        releaseStdoutGuard();
      }
      // A pipeline result that reports failure must not be presented as a
      // successful tool call: `isError` is the only signal many hosts forward to
      // the model, and the transport derives the persisted run state from it. The
      // full result stays inside the envelope either way, so flagging the failure
      // removes no information.
      const failed = !result || result.success !== true;
      return { content: [{ type: "text", text: JSON.stringify({ schema_version: 1, run_id: args.run_id || null, state: failed ? "failed" : "completed", result }) }] , ...(failed ? { isError: true } : {}) };
    }
    case "minitok_knowledge_query": return { content: [{ type: "text", text: JSON.stringify(services.knowledge.query(args)) }] };
    case "minitok_knowledge_record": return { content: [{ type: "text", text: JSON.stringify(services.knowledge.record(args)) }] };
    case "minitok_analyze_failures": return { content: [{ type: "text", text: JSON.stringify(services.analysis.analyze(args?.project)) }] };
    case "minitok_recommend_policy": return { content: [{ type: "text", text: JSON.stringify(services.analysis.recommend(args?.project, args?.current_policy)) }] };
    case "minitok_compact_context": return { content: [{ type: "text", text: JSON.stringify(services.compact.compact(args.text, args)) }] };
    case "minitok_collect_evidence": return { content: [{ type: "text", text: JSON.stringify(services.evidence.collect(requireWorkspacePath(args.project, runtimeOptions.workspaceRoot || process.cwd(), "project"))) }] };
    case "minitok_status": { const entitlement = await services.entitlement.status(); const knowledge = services.knowledge.query({ limit: 0 }); return { content: [{ type: "text", text: JSON.stringify({ entitlement, knowledge: { total: knowledge.total } }) }] }; }
    case "minitok_observe": return { content: [{ type: "text", text: JSON.stringify(services.observation.ingest(args)) }] };
    default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: "TOOL_NOT_FOUND" });
  }
}
async function getToolHandler(name, args, services, runtimeOptions = {}) {
  if (!runtimeOptions.safeResult) return _getToolHandler(name, args, services, runtimeOptions);
  try {
    const result = await _getToolHandler(name, args, services, runtimeOptions);
    const structuredContent = /** @type {any} */ (result).structuredContent || (() => {
      try { return JSON.parse(result.content?.find(item => item.type === "text")?.text || "null"); } catch { return null; }
    })();
    // A handler that already decided the call failed keeps its flag: overwriting
    // it unconditionally made `isError` impossible to set from a handler.
    return { ...result, structuredContent, isError: result.isError === true };
  } catch (error) {
    const code = error.code || "MCP_TOOL_ERROR";
    const structuredContent = { schema_version: 1, error: { code, message: error.message } };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: true, error: { code, message: error.message } };
  }
}
module.exports = { getToolDefinitions, getToolHandler, validateArgs, MCP_ERROR_CODES, TOOL_SCOPES, TOOL_EXTRA_SCOPES, requiredScopeFor, requiredExtraScopesFor, requireWorkspacePath, requireApprovalPath, acquireStdoutGuard, releaseStdoutGuard };

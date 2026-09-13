"use strict";

const { createRuntimeServices } = require("./index");
const { getToolDefinitions, getToolHandler, MCP_ERROR_CODES, requiredScopeFor } = require("../mcp/tools");
const packageMetadata = require("../../package.json");
const version = typeof packageMetadata.version === "string" ? packageMetadata.version : "unknown";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { readRuntimeToken } = require("../mcp/runtime-token");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");
const LOCAL_MCP_SCOPES = new Set(["read", "write", "auto_accept"]);

function parseLocalMcpScopes(value = "read") {
  const scopes = String(value).split(",").map(item => item.trim()).filter(Boolean);
  const normalized = scopes.length ? [...new Set(scopes)] : ["read"];
  const unknown = normalized.find(scope => !LOCAL_MCP_SCOPES.has(scope));
  if (unknown) throw Object.assign(new Error(`Unknown local MCP scope: ${unknown}`), { code: "INVALID_SCOPE" });
  return normalized;
}

const SUPPORTED_PROTOCOLS = ["2024-11-05"];
const RUN_STATE_VERSION = 2;
const RUN_STATES = new Set(["running", "completed", "failed", "cancelled", "unknown"]);

function runtimeBinding(options, authToken) {
  const explicit = options.runtimeIdentity || options.bindingId || process.env.MINITOK_MCP_RUNTIME_IDENTITY;
  if (typeof explicit === "string" && explicit) return explicit;
  const installation = options.installationId || process.env.MINITOK_INSTALLATION_ID;
  if (typeof installation === "string" && installation) return installation;
  return authToken ? crypto.createHash("sha256").update(authToken).digest("hex") : null;
}

function safeRunRecord(record, binding, migrate = false) {
  if (!record || typeof record !== "object" || typeof record.run_id !== "string" || !record.run_id) return null;
  const recordBinding = typeof record.binding_id === "string" ? record.binding_id : null;
  if (recordBinding && binding && recordBinding !== binding) return null;
  if (recordBinding && !binding) return null;
  if (!recordBinding && !migrate) return null;
  const state = RUN_STATES.has(record.state) ? record.state : "unknown";
  const result = { run_id: record.run_id, state };
  if (binding || recordBinding) result.binding_id = binding || recordBinding;
  if (record.request_id !== undefined && (typeof record.request_id === "string" || typeof record.request_id === "number")) result.request_id = record.request_id;
  if (record.started_at) result.started_at = record.started_at;
  if (record.completed_at) result.completed_at = record.completed_at;
  if (state === "running") { result.state = "unknown"; result.recovery = "interrupted"; }
  return result;
}

function loadAuthTokenFile(filePath, fileSystem = fs) {
  if (typeof filePath !== "string" || !filePath) return null;
  const runtime = readRuntimeToken(filePath);
  if (runtime) return runtime.token;
  if (filePath.endsWith("runtime-token.json")) return null;
  try {
    const value = fileSystem.readFileSync(filePath, "utf8").trim();
    if (!value) return null;
    try {
      const record = JSON.parse(value);
      return typeof record.token === "string" && record.token ? record.token : null;
    } catch {
      return value;
    }
  } catch {
    return null;
  }
}

function isValidJsonRpcRequest(msg) {
  const isObject = msg !== null && typeof msg === "object" && !Array.isArray(msg);
  const hasId = isObject && Object.prototype.hasOwnProperty.call(msg, "id");
  const validId = !hasId || msg.id === null || (typeof msg.id === "string" && msg.id.length > 0) || (typeof msg.id === "number" && Number.isFinite(msg.id));
  const validParams = !isObject || msg.params === undefined || (msg.params !== null && typeof msg.params === "object" && !Array.isArray(msg.params));
  return isObject && msg.jsonrpc === "2.0" && typeof msg.method === "string" && msg.method.length > 0 && validId && validParams;
}

/**
 * Upper bound for one newline-delimited JSON-RPC request over stdio.
 *
 * The HTTP transport already caps a request body at 1 MB; stdio buffered an
 * unbounded line, so a client that never sent a newline could grow the buffer
 * until the process ran out of memory.
 */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Split incoming stdio data into complete lines while keeping the remainder.
 * Extracted so the framing and its size guard can be unit tested.
 * @param {string} buffer text already held back
 * @param {string} chunk newly received text
 * @param {number} maxBytes maximum length of an incomplete line
 * @returns {{ lines: string[], rest: string, oversized: boolean }}
 */
function drainStdioLines(buffer, chunk, maxBytes = MAX_REQUEST_BYTES) {
  const segments = `${buffer}${chunk}`.split("\n");
  const rest = segments.pop() || "";
  if (rest.length > maxBytes) return { lines: segments, rest: "", oversized: true };
  return { lines: segments, rest, oversized: false };
}

class RuntimeStdio {
  constructor(options = {}) {
    this._services = options.services || createRuntimeServices(options);
    this._fs = options.fs || fs;
    // Keep the injected pipeline so embedders and tests can run the server
    // without the real pipeline (which performs paid calls and workspace writes).
    // Without this the option was accepted and then silently ignored.
    this._runPipeline = options.runPipeline || null;
    this._workspaceRoot = options.workspaceRoot || process.cwd();
    if (options.authRequired === false || options.entitlementRequired === false) throw new Error("MCP authentication and entitlement are mandatory");
    // Scopes are opt-in: the default stays read-only (tests/test-mcp-remote.js
    // asserts `["read"]`), and write/auto_accept must be granted explicitly.
    // Without the env fallback there was no reachable path to grant them, so
    // every destructive MCP tool failed with PERMISSION_DENIED no matter how
    // the server was launched. MINITOK_MCP_SCOPES lets `mcp connect --scopes`
    // and `runtime start --scopes` deliver the grant to the server process.
    this._permissions = new Set(parseLocalMcpScopes(options.permissions || process.env.MINITOK_MCP_SCOPES || "read"));
    this._authRequired = true;
    this._entitlementRequired = true;
    this._authToken = options.authToken || process.env.MINITOK_MCP_AUTH_TOKEN || loadAuthTokenFile(options.authTokenFile || process.env.MINITOK_MCP_AUTH_TOKEN_FILE, this._fs);
    this._bindingId = runtimeBinding(options, this._authToken);
    this._nextAuthToken = options.nextAuthToken || process.env.MINITOK_MCP_AUTH_TOKEN_NEXT || null;
    this._authExpiresAt = Number(options.authExpiresAt || process.env.MINITOK_MCP_AUTH_TOKEN_EXPIRES_AT || 0) || 0;
    this._nextAuthExpiresAt = Number(options.nextAuthExpiresAt || process.env.MINITOK_MCP_AUTH_TOKEN_NEXT_EXPIRES_AT || 0) || 0;
    this._authIssuedAt = Date.now();
    this._authTtlMs = Number(options.authTtlMs || process.env.MINITOK_MCP_AUTH_TOKEN_TTL_MS || 0) || 0;
    this._revokedTokens = new Set([...(options.revokedTokens || []), ...String(process.env.MINITOK_MCP_AUTH_TOKEN_REVOKED || "").split(",").map(value => value.trim()).filter(Boolean)]);
    this._runStatePath = options.runStatePath || path.join(os.homedir(), ".minitok", "mcp-runs.json");
    this._persistence = { persisted: true, error: null, operation: "load" };
    this._recoveredRuns = this._loadRunState();
    this._runs = new Map();
    this._requestToRun = new Map();
    this._maxConcurrentRuns = Math.max(1, Number(options.maxConcurrentRuns || process.env.MINITOK_MCP_MAX_CONCURRENT_RUNS || 1));
    this._clientInfo = null;
    this._sessionToken = null;
    this._initialized = false;
  }
  _loadRunState() {
    try {
      const value = JSON.parse(this._fs.readFileSync(this._runStatePath, "utf8"));
      const versionedValue = !Array.isArray(value) && value !== null && typeof value === "object" ? value : null;
      const records = Array.isArray(value) ? value : versionedValue && versionedValue.version === RUN_STATE_VERSION && Array.isArray(versionedValue.records) ? versionedValue.records : (() => { throw new Error("MCP run state must be an array"); })();
      const migrated = !Array.isArray(value) || !versionedValue || versionedValue.version !== RUN_STATE_VERSION;
      const filtered = records.map(record => safeRunRecord(record, this._bindingId, migrated)).filter(Boolean);
      this._persistence = { persisted: true, error: null, operation: "load" };
      return filtered;
    } catch (error) {
      if (error.code === "ENOENT") {
        this._persistence = { persisted: true, error: null, operation: "load" };
      } else {
        this._persistence = { persisted: false, error: error.message, operation: "load" };
      }
      return [];
    }
  }
  _saveRunState() {
    const temp = `${this._runStatePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
    try {
      this._fs.mkdirSync(path.dirname(this._runStatePath), { recursive: true, mode: 0o700 });
      const records = [...this._recoveredRuns.filter(record => !this._runs.has(record.run_id)), ...[...this._runs.values()].map(run => ({ run_id: run.runId, request_id: run.requestId, state: RUN_STATES.has(run.state) ? run.state : "unknown", binding_id: this._bindingId }))].slice(-100);
      this._fs.writeFileSync(temp, JSON.stringify({ version: RUN_STATE_VERSION, records }), { flag: "wx", mode: 0o600 });
      setOwnerOnlyPermissions(temp);
      try {
        const fd = this._fs.openSync(temp, "r");
        try { this._fs.fsyncSync(fd); } finally { this._fs.closeSync(fd); }
      } catch (error) {
        if (!(process.platform === "win32" && ["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error.code))) throw error;
      }
      this._fs.renameSync(temp, this._runStatePath);
      try {
        const dirFd = this._fs.openSync(path.dirname(this._runStatePath), "r");
        try { this._fs.fsyncSync(dirFd); } finally { this._fs.closeSync(dirFd); }
      } catch (error) {
        if (!(process.platform === "win32" && ["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error.code))) throw error;
      }
      this._persistence = { persisted: true, error: null, operation: "save" };
      return this._persistence;
    } catch (error) {
      try { this._fs.rmSync(temp, { force: true }); } catch {}
      this._persistence = { persisted: false, error: error.message, operation: "save" };
      return this._persistence;
    }
  }
  rotateAuthToken(token, expiresAt = 0) {
    if (!token || typeof token !== "string") throw new TypeError("token is required");
    this._nextAuthToken = token;
    this._nextAuthExpiresAt = Number(expiresAt) || 0;
    return token;
  }
  revokeAuthToken(token) {
    if (token) this._revokedTokens.add(token);
  }
  _authValue(params) {
    const value = params.authToken || params.auth_token || params.authorization || params.headers?.Authorization || params.headers?.authorization;
    if (typeof value !== "string") return null;
    return value.replace(/^Bearer\s+/i, "").trim() || null;
  }
  _authValid(token) {
    if (!token || this._revokedTokens.has(token)) return false;
    const currentExpired = this._authExpiresAt > 0 ? Date.now() >= this._authExpiresAt : this._authTtlMs > 0 && Date.now() - this._authIssuedAt >= this._authTtlMs;
    const nextExpired = this._nextAuthExpiresAt > 0 && Date.now() >= this._nextAuthExpiresAt;
    return [this._authToken && !currentExpired, this._nextAuthToken && !nextExpired].some((valid, index) => {
      const expected = index === 0 ? this._authToken : this._nextAuthToken;
      if (!valid || typeof expected !== "string") return false;
      const supplied = Buffer.from(token); const target = Buffer.from(expected);
      return supplied.length === target.length && crypto.timingSafeEqual(supplied, target);
    });
  }
  start() {
    process.stdin.setEncoding("utf-8");
    let buffer = "";
    process.stdin.on("data", chunk => {
      const { lines, rest, oversized } = drainStdioLines(buffer, String(chunk));
      buffer = rest;
      for (const line of lines) this._handleLine(line.trim());
      if (oversized) {
        // A single line longer than any legitimate request: report it and drop the
        // buffer instead of growing it until the process runs out of memory. The
        // HTTP transport already caps a request body at 1 MB.
        this._respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Request exceeds the maximum line length (${MAX_REQUEST_BYTES} bytes)`, data: { type: "INVALID_REQUEST" } } });
      }
    });
    process.stdin.on("end", () => { if (buffer.trim()) this._handleLine(buffer.trim()); });
  }
  async _handleLine(line, respond = this._respond.bind(this)) {
     if (!line) return;
     let msg;
     try { msg = JSON.parse(line); } catch { respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error", data: { type: "PARSE_ERROR" } } }); return; }
     if (Array.isArray(msg)) {
       if (msg.length === 0) return respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
       const responses = [];
       for (const item of msg) await this._handleMessage(item, value => responses.push(value));
       for (const response of responses) respond(response);
       return;
     }
     await this._handleMessage(msg, respond);
   }
   async _handleMessage(msg, respond = this._respond.bind(this)) {

    const isObject = msg !== null && typeof msg === "object" && !Array.isArray(msg);
    const hasId = isObject && Object.prototype.hasOwnProperty.call(msg, "id");
    if (!isValidJsonRpcRequest(msg)) return respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    const isNotification = !hasId;
    const reply = value => { if (!isNotification) respond(value); };
    const { id, method, params = {} } = msg;
    const correlationId = params.correlation_id || crypto.randomUUID();
    if (this._authRequired && !this._authToken && !this._nextAuthToken && method !== "initialize") return this._error(id, MCP_ERROR_CODES.AUTH_REQUIRED, "Authentication required", "AUTH_REQUIRED", correlationId, {}, reply);
    if (this._authRequired && method !== "initialize" && (!this._initialized || !this._authValid(this._authValue(params)) || this._authValue(params) !== this._sessionToken)) return this._error(id, MCP_ERROR_CODES.AUTH_REQUIRED, "Authentication required", "AUTH_REQUIRED", correlationId, {}, reply);
    if (method === "initialize") {
      const requested = Array.isArray(params.protocolVersions) ? params.protocolVersions : [params.protocolVersion];
      const protocolVersion = requested.find(version => SUPPORTED_PROTOCOLS.includes(version));
      if (!protocolVersion) return this._error(id, -32602, "Unsupported protocol version", "PROTOCOL_VERSION_UNSUPPORTED", correlationId, { supported: SUPPORTED_PROTOCOLS }, reply);
      // Reject a token the server would refuse later. initialize used to accept
      // any value, so a bogus token produced a successful handshake followed by
      // AUTH_REQUIRED on every subsequent call.
      const suppliedToken = this._authValue(params);
      if (this._authRequired && suppliedToken && !this._authValid(suppliedToken)) {
        return this._error(id, MCP_ERROR_CODES.AUTH_REQUIRED, "Authentication required", "AUTH_REQUIRED", correlationId, {}, reply);
      }
       this._clientInfo = params.clientInfo && typeof params.clientInfo === "object" ? { name: String(params.clientInfo.name || "unknown").slice(0, 128), version: String(params.clientInfo.version || "").slice(0, 64) } : null;
       this._sessionToken = this._authValue(params) || this._authToken || this._nextAuthToken;
        this._initialized = true;
          reply({ jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } }, serverInfo: { name: "minitok-runtime", version } } }); return;
    }
     if (method === "notifications/initialized") return;
      if (this._entitlementRequired && ["resources/list", "resources/read", "prompts/list", "prompts/get", "tools/list", "tools/call"].includes(method)) {
        const policy = await this._services.entitlement.status();
        if (!policy?.allowed) return this._error(id, MCP_ERROR_CODES.PERMISSION_DENIED, policy?.message || "Paid entitlement required", "ENTITLEMENT_REQUIRED", correlationId, { state: policy?.state }, reply);
      }
     if (method === "notifications/cancelled") { const runId = params.run_id || this._requestToRun.get(params.requestId); const run = this._runs.get(runId); if (run) { run.state = "cancelled"; run.controller.abort(); run.persistence = this._saveRunState(); } return; }
    if (method === "resources/list") return reply({ jsonrpc: "2.0", id, result: { resources: [{ uri: "minitok://status", name: "minitok status", mimeType: "application/json" }, { uri: "minitok://runs", name: "minitok runs", mimeType: "application/json" }] } });
    if (method === "resources/read") { if (!["minitok://status", "minitok://runs"].includes(params.uri)) return this._error(id, MCP_ERROR_CODES.NOT_FOUND, "Resource not found", "RESOURCE_NOT_FOUND", correlationId, {}, reply); const value = params.uri === "minitok://runs" ? [...this._runs.values(), ...this._recoveredRuns].map(run => ({ run_id: run.runId || run.run_id, state: run.state })) : await this._services.entitlement.status(); return reply({ jsonrpc: "2.0", id, result: { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(value) }] } }); }
    if (method === "prompts/list") return reply({ jsonrpc: "2.0", id, result: { prompts: [{ name: "minitok_task", description: "Start a verified autonomous minitok task", arguments: [{ name: "task", required: true }] }] } });
     if (method === "prompts/get") { if (params.name !== "minitok_task") return this._error(id, MCP_ERROR_CODES.NOT_FOUND, "Prompt not found", "PROMPT_NOT_FOUND", correlationId, {}, reply); return reply({ jsonrpc: "2.0", id, result: { description: "Verified minitok task", messages: [{ role: "user", content: { type: "text", text: String(params.arguments?.task || "") } }] } }); }
    if (method === "tools/list") return reply({ jsonrpc: "2.0", id, result: { tools: getToolDefinitions() } });
    if (method !== "tools/call") return this._error(id, -32601, `Method not found: ${method}`, "METHOD_NOT_FOUND", correlationId, {}, reply);
    const definition = getToolDefinitions().find(tool => tool.name === params.name);
    if (!definition) return this._error(id, MCP_ERROR_CODES.NOT_FOUND, "Tool not found", "TOOL_NOT_FOUND", correlationId, {}, reply);
    // Scope comes from the explicit per-tool table, not from destructiveHint:
    // additive writers such as minitok_knowledge_record must not run under the
    // read-only default scope.
    const requiredScope = requiredScopeFor(params.name);
    if (!this._permissions.has(requiredScope)) return this._error(id, MCP_ERROR_CODES.PERMISSION_DENIED, requiredScope === "write" ? "Workspace write permission required" : "Read permission required", "PERMISSION_DENIED", correlationId, {}, reply);
    if (params.name === "minitok_run" && [...this._runs.values()].filter(run => run.state === "running").length >= this._maxConcurrentRuns) return this._error(id, MCP_ERROR_CODES.RUN_LIMIT_REACHED, "Concurrent run limit reached", "RUN_LIMIT_REACHED", correlationId, {}, reply);
    const runId = params.name === "minitok_run" ? crypto.randomUUID() : null;
    const controller = new AbortController();
     if (runId) {
       this._runs.set(runId, { runId, requestId: id, controller, state: "running", persistence: null });
       this._requestToRun.set(id, runId);
       const persistence = this._saveRunState();
       const run = this._runs.get(runId);
       if (run) run.persistence = persistence;
     }
     try {
      // Inject the server-generated run id for minitok_run only. Spreading the
      // id over every tool replaced the declared run_id of minitok_run_get,
      // minitok_run_cancel, minitok_approve_run and minitok_reject_run with
      // null, so all four failed schema validation through the transport.
      const toolArguments = { ...(params.arguments || {}) };
      if (runId) toolArguments.run_id = runId;
      const result = await getToolHandler(params.name, toolArguments, this._services, { safeResult: true, signal: controller.signal, runs: this._runs, runPipeline: this._runPipeline, recoveredRuns: this._recoveredRuns, persistence: this._persistence, workspaceRoot: this._workspaceRoot, permissions: this._permissions, writeApproval: (file, decision, binding) => { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(file) !== file) throw Object.assign(new Error("Approval request path is not a regular file"), { code: "APPROVAL_INVALID" }); let request; try { request = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw Object.assign(new Error("Approval request is malformed"), { code: "APPROVAL_INVALID" }); } if (request.type !== "approval_request" || (decision !== "approve" && decision !== "reject") || typeof request.nonce !== "string" || request.nonce !== binding.nonce || request.run_id !== binding.runId || !Number.isFinite(request.expires_at) || Date.now() >= request.expires_at) throw Object.assign(new Error("Approval request is stale or mismatched"), { code: "APPROVAL_INVALID" }); const target = `${file}.response`; try { const targetStat = fs.lstatSync(target); if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw Object.assign(new Error("Approval response path is not a regular file"), { code: "APPROVAL_INVALID" }); } catch (error) { if (error.code !== "ENOENT") throw error; } const temp = `${target}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`; const fd = fs.openSync(temp, "wx", 0o600); try { fs.writeFileSync(fd, `${JSON.stringify({ decision, nonce: binding.nonce, run_id: binding.runId })}\n`, { encoding: "utf8" }); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } try { fs.renameSync(temp, target); } catch (error) { try { fs.rmSync(temp, { force: true }); } catch {} throw error; } }, onProgress: event => { if (runId && !isNotification) { const progress = Number.isFinite(event.progress) ? event.progress : ({ intel: 1, plan: 2, work: 3, verify: 4, review: 5 }[event.phase] || 0); this._respond({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: params._meta?.progressToken ?? params.meta?.progressToken ?? null, progress, total: 5, message: JSON.stringify({ phase: event.phase, state: event.state, run_id: runId, correlation_id: correlationId }) } }); } } });
       if (runId) { const run = this._runs.get(runId); if (run && run.state !== "cancelled" && !controller.signal.aborted) run.state = "completed"; if (run) { run.result = result; run.persistence = this._saveRunState(); } }
        reply({ jsonrpc: "2.0", id, result: { ...result, run_id: runId, correlation_id: correlationId, structuredContent: result.structuredContent || null, persistence: runId ? this._runs.get(runId)?.persistence || this._persistence : undefined, isError: result.isError === true } });
     } catch (error) { if (runId) { const run = this._runs.get(runId); if (run) { run.state = controller.signal.aborted ? "cancelled" : "failed"; run.result = { error: error.message }; run.persistence = this._saveRunState(); } } this._error(id, this._errorCode(error.code), error.message, error.code || "MCP_TOOL_ERROR", correlationId, { run_id: runId, persistence: runId ? this._runs.get(runId)?.persistence || this._persistence : undefined }, reply); }
    finally { if (runId) { this._requestToRun.delete(id); } }
  }
  _error(id, code, message, type, correlationId, extra = {}, respond = this._respond.bind(this)) { respond({ jsonrpc: "2.0", id, error: { code, message, data: { type, correlation_id: correlationId, ...extra } } }); }
  _errorCode(code) { return code === "INVALID_PARAMS" || code === "INVALID_PATH" || code === "PATH_OUTSIDE_WORKSPACE" ? -32602 : code === "RUN_NOT_FOUND" || code === "TOOL_NOT_FOUND" ? MCP_ERROR_CODES.NOT_FOUND : MCP_ERROR_CODES.TOOL_ERROR; }
  _respond(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }
}
module.exports = { RuntimeStdio, SUPPORTED_PROTOCOLS, isValidJsonRpcRequest, loadAuthTokenFile, parseLocalMcpScopes, LOCAL_MCP_SCOPES, drainStdioLines, MAX_REQUEST_BYTES };

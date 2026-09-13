"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { createRuntimeServices } = require("./index");
const { createRoutes } = require("./routes");
const { RuntimeStdio, isValidJsonRpcRequest } = require("./stdio");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");
const { runtimeTokenPath, readRuntimeToken } = require("../mcp/runtime-token");

const DEFAULT_PORT = 4578;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HOME = path.join(os.homedir(), ".minitok");
const PID_FILE = path.join(DEFAULT_HOME, "runtime.pid");
const TOKEN_FILE = path.join(DEFAULT_HOME, "runtime.token");
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const HEADER_TIMEOUT_MS = 10 * 1000;
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_MCP_SESSIONS = 64;
const MCP_SESSION_PATTERN = /^[a-f0-9]{32}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;

class RuntimeServer {
  constructor(options = {}) {
    this._port = options.port != null ? options.port : DEFAULT_PORT;
    const runtimeDir = options.runtimeDir;
    this._services = createRuntimeServices(options);
    this._server = null;
    this._started = false;
    this._ready = false;
    this._idleTimer = null;
    this._activeRequests = 0;
    this._routes = createRoutes(this._services);
    this._pidFile = options.pidFile || (runtimeDir && path.join(runtimeDir, "runtime.pid")) || PID_FILE;
    this._tokenFile = options.tokenFile || (runtimeDir && path.join(runtimeDir, "runtime.token")) || TOKEN_FILE;
    this._mcpTokenFile = options.mcpTokenFile || runtimeTokenPath(options.entitlementDir);
    if (options.authRequired === false || options.entitlementRequired === false) throw new Error("MCP authentication and entitlement are mandatory");
    const mcpToken = options.mcpToken || readRuntimeToken(this._mcpTokenFile);
    this._runtimeToken = options.runtimeToken || this._loadRuntimeToken() || mcpToken?.token || crypto.randomBytes(32).toString("hex");
    this._mcpOptions = { ...options, services: this._services, workspaceRoot: options.workspaceRoot || process.cwd(), authToken: this._runtimeToken, authExpiresAt: mcpToken?.expires_at || 0, authTokenFile: this._mcpTokenFile };
    this._mcpSessions = new Map();
    this._mcpSocketSessions = new WeakMap();
    this._mcp = new RuntimeStdio(this._mcpOptions);
    this._authRequired = true;
    this._entitlementRequired = true;
    this._maxConcurrentRequests = options.maxConcurrentRequests || MAX_CONCURRENT_REQUESTS;
    this._requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
    this._lockFile = options.lockFile || `${this._pidFile}.lock`;
    this._lockNonce = crypto.randomBytes(16).toString("hex");
    this._lockOwned = false;
    this._maxMcpSessions = Math.max(1, Number(options.maxMcpSessions || MAX_MCP_SESSIONS));
    // Idle shutdown is configurable: the fixed 30 minute default silently killed
    // a detached runtime that a client had configured. 0 disables it.
    this._idleTimeoutMs = options.idleTimeoutMs === 0 ? 0 : Math.max(0, Number(options.idleTimeoutMs ?? IDLE_TIMEOUT_MS) || IDLE_TIMEOUT_MS);
    this._metrics = { requests_total: 0, requests_failed: 0, mcp_requests_total: 0, mcp_sessions_created: 0, mcp_sessions_evicted: 0, last_error: null, started_at: null };
  }

  async start() {
    this._acquireLock();
    this._server = http.createServer((req, res) => this._handleRequest(req, res));
    this._server.headersTimeout = HEADER_TIMEOUT_MS;
    this._server.requestTimeout = this._requestTimeoutMs;
    return new Promise((resolve, reject) => {
      this._server.on("error", error => { this._removePid(); this._releaseLock(); reject(error); });
      this._server.listen(this._port, HOST, () => {
        const address = this._server.address();
        this._port = typeof address === "string" || address === null ? this._port : address.port;
        try {
          this._writePid();
        } catch (error) {
           this._server.close(() => this._releaseLock());
           reject(new Error(`Unable to secure runtime credentials: ${error.message}`));
          return;
        }
        this._started = true;
        this._ready = true;
        this._metrics.started_at = new Date().toISOString();
        resolve();
      });
    });
  }

  async stop() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._ready = false;
    this._mcpSessions.clear();
    this._removePid();
    if (this._server && this._started) return new Promise(resolve => { this._server.close(() => { this._started = false; this._releaseLock(); resolve(); }); });
    this._releaseLock();
  }

  async _handleRequest(req, res) {
    this._metrics.requests_total++;
    if (this._activeRequests >= this._maxConcurrentRequests) {
      this._metrics.requests_failed++;
      return this._sendJson(res, 503, { error: "Too many concurrent requests" });
    }
    this._activeRequests++;
    this._resetIdleTimer();
    try {
      const remoteAddr = req.socket?.remoteAddress || "";
      if (remoteAddr && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr)) return this._sendJson(res, 403, { error: "Forbidden: localhost only" });
      const url = new URL(req.url, `http://${HOST}:${this._port}`);
      const routeKey = `${req.method} ${url.pathname}`;
      const route = this._routes[routeKey];
      if (!route && routeKey !== "POST /mcp" && routeKey !== "GET /metrics") return this._sendJson(res, 404, { error: "Not found" });
      if (this._authRequired && !(["GET /health", "GET /readyz"].includes(routeKey)) && !this._isAuthorized(req)) return this._sendJson(res, 401, { error: "Unauthorized" });
      if (this._entitlementRequired && routeKey !== "POST /mcp" && !(["GET /health", "GET /readyz", "GET /metrics", "GET /api/v1/status"].includes(routeKey))) {
        const policy = await this._services.entitlement.status();
        if (!policy?.allowed) return this._sendJson(res, 403, { error: policy?.message || "Entitlement required", state: policy?.state });
      }
      let body = null;
      if (req.method === "POST") {
        const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") return this._sendJson(res, 415, { error: "Content-Type must be application/json" });
        const declaredLength = req.headers["content-length"] == null ? 0 : Number(req.headers["content-length"]);
        if (!Number.isFinite(declaredLength) || declaredLength < 0) return this._sendJson(res, 400, { error: "Invalid Content-Length" });
         if (declaredLength > MAX_BODY_BYTES) {
           req.resume();
           return this._sendJson(res, 413, { error: "Request body too large" });
        }
        body = await this._readBody(req);
      }
      if (routeKey === "POST /mcp") {
        this._metrics.mcp_requests_total++;
        return this._handleMcpRequestBody(req, res, body || {});
      }
      if (routeKey === "GET /metrics") return this._sendJson(res, 200, { ...this.metrics, entitlement_required: this._entitlementRequired, auth_required: this._authRequired });
      const params = {};
      url.searchParams.forEach((v, k) => { params[k] = v; });
      const result = await route({ body: body || {}, params });
      this._sendJson(res, result.status || 200, result.data || result);
    } catch (err) {
      this._metrics.requests_failed++;
      this._metrics.last_error = { code: err.code || null, status: err.statusCode || 500, at: new Date().toISOString() };
      if (req.method === "POST" && new URL(req.url, `http://${HOST}:${this._port}`).pathname === "/mcp" && err.statusCode === 400) return this._sendJson(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      this._sendJson(res, err.statusCode || 500, { error: err.statusCode === 413 ? "Request body too large" : err.statusCode === 400 ? "Malformed JSON" : "Internal error" });
    } finally {
      this._activeRequests--;
      this._resetIdleTimer();
    }
  }

  _createMcpSession() {
    return new RuntimeStdio(this._mcpOptions);
  }

  async _handleMcpRequestBody(req, res, body, authorization = req.headers.authorization || "") {
    const messages = Array.isArray(body) ? body : [body];
    const token = /^Bearer ([^\s]+)$/.exec(authorization)?.[1];
    const requestedId = req.headers["mcp-session-id"];
    if (requestedId !== undefined && (typeof requestedId !== "string" || !MCP_SESSION_PATTERN.test(requestedId))) return this._sendJson(res, 400, { error: "Invalid MCP session identifier" });
    let sessionId = requestedId || this._mcpSocketSessions.get(req.socket);
    let session = sessionId ? this._mcpSessions.get(sessionId) : null;
    if (session && sessionId) {
      // Map iteration order is insertion order, so refresh recency here: the
      // eviction below then drops the least recently used session instead of the
      // oldest created one, which could be the session in active use.
      this._mcpSessions.delete(sessionId);
      this._mcpSessions.set(sessionId, session);
    }
    if (!session) {
      if (sessionId) return this._sendJson(res, 404, { error: "MCP session not found" });
      sessionId = crypto.randomBytes(16).toString("hex");
       session = this._createMcpSession();

      this._metrics.mcp_sessions_created++;
      if (this._mcpSessions.size >= this._maxMcpSessions) {
        const oldest = this._mcpSessions.keys().next().value;
        this._mcpSessions.delete(oldest);
        this._metrics.mcp_sessions_evicted++;
      }
      this._mcpSessions.set(sessionId, session);
      this._mcpSocketSessions.set(req.socket, sessionId);
    }
    const responses = [];
    const respond = message => responses.push(message);
    for (const message of messages) {
      if (!isValidJsonRpcRequest(message)) {
        responses.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
        continue;
      }
      const params = message.params === undefined ? {} : { ...message.params };
      if (token) params.authToken = token;
      await session._handleLine(JSON.stringify({ ...message, params }), respond);
    }
    res.setHeader("Mcp-Session-Id", sessionId);
    if (Array.isArray(body)) {
      if (body.length === 0) return this._sendJson(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return this._sendJson(res, 200, responses);
    }
    if (!responses.length) return res.writeHead(202).end();
    this._sendJson(res, 200, responses[responses.length - 1]);
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let stopped = false;
       const fail = (statusCode, message) => {
         if (stopped) return;
         stopped = true;
         req.resume();
         reject(Object.assign(new Error(message), { statusCode }));
       };
      req.on("data", chunk => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) return fail(413, "Request body too large");
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (stopped) return;
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { fail(400, "Malformed JSON"); }
      });
      req.on("error", err => reject(err));
    });
  }

  _loadRuntimeToken() {
    try { return fs.readFileSync(this._tokenFile, "utf8").trim() || null; } catch { return null; }
  }

  _isAuthorized(req) {
    const value = req.headers.authorization || "";
    if (!this._runtimeToken || !/^Bearer [^\s]+$/.test(value)) return false;
    const supplied = Buffer.from(value.slice(7));
    const expected = Buffer.from(this._runtimeToken);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  _sendJson(res, status, data) {
    if (res.headersSent) return;
    const payload = JSON.stringify(data) ?? "null";
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  }

  _resetIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._activeRequests === 0 && this._idleTimeoutMs > 0) {
      this._idleTimer = setTimeout(() => { this._shutdownForIdle(); }, this._idleTimeoutMs);
      if (this._idleTimer.unref) this._idleTimer.unref();
    }
  }

  /**
   * Idle shutdown.
   *
   * The process exit has to wait for stop(): the runtime lock is released from
   * inside the server close callback and the pid/token files are cleaned up
   * there too, so a bare process.exit() aborted that cleanup and left a stale
   * lock behind for the next start.
   */
  async _shutdownForIdle() {
    try { await this.stop(); } catch { /* fall through and exit anyway */ }
    process.exit(0);
  }

  _readLock() {
    try {
      const value = JSON.parse(fs.readFileSync(this._lockFile, "utf8"));
      if (!Number.isInteger(value?.pid) || typeof value.nonce !== "string") return null;
      return value;
    } catch { return null; }
  }

  _pidIsRunning(pid) {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
  }

  _acquireLock() {
    fs.mkdirSync(path.dirname(this._lockFile), { recursive: true, mode: 0o700 });
    const lock = JSON.stringify({ pid: process.pid, nonce: this._lockNonce, startedAt: new Date().toISOString() }) + "\n";
    try {
      const fd = fs.openSync(this._lockFile, "wx", 0o600);
      try { fs.writeFileSync(fd, lock, { encoding: "utf8" }); } finally { fs.closeSync(fd); }
      this._lockOwned = true;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const existing = this._readLock();
    if (existing && this._pidIsRunning(existing.pid)) throw new Error("Runtime is already running");
    try { fs.unlinkSync(this._lockFile); } catch {}
    try {
      const fd = fs.openSync(this._lockFile, "wx", 0o600);
      try { fs.writeFileSync(fd, lock, { encoding: "utf8" }); } finally { fs.closeSync(fd); }
      this._lockOwned = true;
    } catch { throw new Error("Runtime is already running"); }
  }

  _releaseLock() {
    if (!this._lockOwned) return;
    try {
      const current = this._readLock();
      if (current?.pid === process.pid && current.nonce === this._lockNonce) fs.unlinkSync(this._lockFile);
    } catch {}
    this._lockOwned = false;
  }

  _writePid() {
    fs.mkdirSync(path.dirname(this._pidFile), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(this._pidFile), 0o700);
    const writeSecure = (file, content) => {
      const temp = `${file}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
      try {
        fs.writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        setOwnerOnlyPermissions(temp);
        fs.renameSync(temp, file);
        setOwnerOnlyPermissions(file);
      } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
      }
    };
     writeSecure(this._tokenFile, `${this._runtimeToken}\n`);
     this._pidNonce = crypto.randomBytes(16).toString("hex");
     writeSecure(this._pidFile, JSON.stringify({ pid: process.pid, nonce: this._pidNonce, startedAt: new Date().toISOString(), port: this._port, tokenFile: this._tokenFile }) + "\n");
  }

  _removePid() {
    let ownsPidFile = false;
    try {
      const value = JSON.parse(fs.readFileSync(this._pidFile, "utf8"));
      ownsPidFile = value?.pid === process.pid && value.nonce === this._pidNonce && value.tokenFile === this._tokenFile;
      if (ownsPidFile) fs.unlinkSync(this._pidFile);
    } catch {}
    if (!ownsPidFile) return;
    try { fs.unlinkSync(this._tokenFile); } catch {}
  }

  get port() { return this._port; }
  get services() { return this._services; }
  get metrics() { return { ...this._metrics, active_requests: this._activeRequests, active_mcp_sessions: this._mcpSessions.size, ready: this._ready }; }
}

module.exports = { RuntimeServer, DEFAULT_PORT, IDLE_TIMEOUT_MS, HOST, MAX_BODY_BYTES, REQUEST_TIMEOUT_MS, HEADER_TIMEOUT_MS, MAX_CONCURRENT_REQUESTS, MAX_MCP_SESSIONS, MCP_SESSION_PATTERN, NONCE_PATTERN, PID_FILE, TOKEN_FILE };

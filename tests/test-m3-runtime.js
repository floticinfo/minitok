const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');

const { createRuntimeServices } = require('../src/runtime/index.js');
const { KnowledgeService } = require('../src/runtime/knowledge.js');
const { AnalysisService } = require('../src/runtime/analysis.js');
const { CompactService } = require('../src/runtime/compact.js');
const { ObservationService, VALID_EVENT_TYPES } = require('../src/runtime/observations.js');
const { RuntimeServer, NONCE_PATTERN } = require('../src/runtime/test-seam.js');
const { _waitForExit, _processMatches } = require('../src/cli/commands/runtime.js');
const { getToolDefinitions, getToolHandler } = require('../src/mcp/tools.js');
const { AuditService } = require('../src/runtime/audit.js');

function tempKnowledgePath(prefix = "m3-knowledge-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, file: path.join(dir, "outcomes.json") };
}

function runtimeFixture(prefix = "m3-runtime-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    runtimeDir: dir,
    knowledgePath: path.join(dir, "knowledge.json"),
    pidFile: path.join(dir, "runtime.pid"),
    tokenFile: path.join(dir, "runtime.token"),
    auditPath: path.join(dir, "audit.jsonl"),
    evidenceDirectory: path.join(dir, "evidence"),
    observationDir: path.join(dir, "observations"),
    entitlementDir: path.join(dir, "entitlement"),
  };
}

function httpFetch(url, headers = {}) {
  return new Promise((resolve) => {
    http.get(url, { headers }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    }).on("error", (e) => resolve({ status: 0, error: e.message }));
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } }, (res) => {
      let b = "";
      res.on("data", c => b += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, data: b }); }
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.end(data);
  });
}

describe("runtime process identity", () => {
  it("rejects a live unrelated Unix PID", { skip: process.platform === "win32" }, () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      assert.equal(_processMatches({ pid: child.pid }), false);
    } finally {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
    }
  });

  it("rejects a replacement process even when the PID is live", { skip: process.platform === "win32" }, () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      assert.equal(_processMatches({ pid: child.pid }), false);
    } finally {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
    }
  });
});

describe("M3 Runtime Services", () => {
  function services() {
    const temp = tempKnowledgePath();
    return { svc: createRuntimeServices({ knowledgePath: temp.file }), temp };
  }

  it("creates all 8 services", () => {
    const { svc, temp } = services();
    assert.ok(svc.knowledge instanceof KnowledgeService);
    assert.ok(svc.analysis instanceof AnalysisService);
    assert.ok(svc.compact instanceof CompactService);
    assert.ok(svc.evidence);
    assert.ok(svc.workspace);
    assert.ok(svc.audit);
    assert.ok(svc.entitlement);
    assert.ok(svc.observation instanceof ObservationService);
    fs.rmSync(temp.dir, { recursive: true, force: true });
  });

  it("knowledge query returns outcomes", () => {
    const { svc } = services();
    const r = svc.knowledge.query({ limit: 5 });
    assert.ok(Array.isArray(r.outcomes));
    assert.equal(typeof r.total, "number");
  });

  it("knowledge record stores outcome", () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    const r = svc.knowledge.record({ goal: "test-m3-" + Date.now(), status: "success", cycles: 1, summary: "m3 test" });
    assert.equal(r.recorded, true);
    assert.equal(typeof r.total, "number");
    assert.ok(r.total > 0);
  });

  it("analysis analyze returns patterns", () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    const r = svc.analysis.analyze();
    assert.ok(Array.isArray(r.patterns));
    assert.ok(Array.isArray(r.recommendations));
  });

  it("analysis recommend returns policy", () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    const r = svc.analysis.recommend(null, { max_cycles: 3 });
    assert.ok(r.recommended);
    assert.ok(Array.isArray(r.reasons));
  });

  it("compact compacts long text", () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    const text = "x".repeat(50000);
    const r = svc.compact.compact(text, { budget_chars: 1000 });
    assert.ok(r.compacted);
    assert.ok(r.text.length <= 1200);
    assert.equal(r.original_chars, 50000);
  });

  it("compact does not compact short text", () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    const r = svc.compact.compact("hello", { budget_chars: 1000 });
    assert.equal(r.compacted, false);
    assert.equal(r.text, "hello");
  });

  it("entitlement status returns valid structure", async () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    const r = await svc.entitlement.status();
    assert.equal(typeof r.allowed, "boolean");
    assert.equal(typeof r.state, "string");
    assert.equal(typeof r.message, "string");
  });

  it("audit service logs and reads", () => {
    const fixture = runtimeFixture("m3-audit-");
    try {
      const audit = new AuditService(fixture.auditPath);
      audit.log({ action: "test", file: "test.js" });
      const entries = audit.recent(10);
      assert.ok(entries.length >= 1);
      assert.equal(entries[entries.length - 1].action, "test");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("M3 Observation Service", () => {
  it("ingests valid events", () => {
    const fixture = runtimeFixture("m3-observation-");
    const obs = new ObservationService({ storageDir: fixture.observationDir });
    const r = obs.ingest({ project: "test-proj", events: [
      { type: "file_modified", path: "src/a.js", action: "modify" },
      { type: "test_result", command: "npm test", passed: true },
    ]});
    assert.equal(r.accepted, 2);
    assert.equal(r.errors.length, 0);
  });

  it("rejects invalid event types", () => {
    const fixture = runtimeFixture("m3-observation-invalid-");
    const obs = new ObservationService({ storageDir: fixture.observationDir });
    const r = obs.ingest({ events: [{ type: "invalid_type" }] });
    assert.equal(r.accepted, 0);
    assert.equal(r.errors.length, 1);
  });

  it("handles empty events array", () => {
    const obs = new ObservationService({ storageDir: runtimeFixture("m3-observation-empty-").observationDir });
    const r = obs.ingest({ events: [] });
    assert.equal(r.accepted, 0);
  });

  it("validates all event types", () => {
    assert.ok(VALID_EVENT_TYPES.includes("file_modified"));
    assert.ok(VALID_EVENT_TYPES.includes("test_result"));
    assert.ok(VALID_EVENT_TYPES.includes("task_started"));
    assert.ok(VALID_EVENT_TYPES.includes("session_end"));
  });
});

describe("M3 HTTP Server", () => {
  let server;

  it("reclaims a stale runtime lock after a crash", async () => {
    const temp = runtimeFixture("m3-server-stale-lock-");
    const lockFile = path.join(temp.dir, "runtime.pid.lock");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999999, nonce: "crashed", startedAt: new Date().toISOString() }) + "\n", "utf8");
    const recovered = new RuntimeServer({ ...temp, port: 0, authRequired: false, entitlementRequired: false });
    await recovered.start();
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid, process.pid);
    await recovered.stop();
    fs.rmSync(temp.dir, { recursive: true, force: true });
  });

  it("does not release a replacement runtime lock", () => {
    const temp = runtimeFixture("m3-server-lock-ownership-");
    const first = new RuntimeServer({ ...temp, authRequired: false, entitlementRequired: false });
    first._acquireLock();
    fs.writeFileSync(temp.lockFile || path.join(temp.dir, "runtime.pid.lock"), JSON.stringify({ pid: process.pid, nonce: "replacement", startedAt: new Date().toISOString() }) + "\n", "utf8");
    first._releaseLock();
    assert.equal(fs.existsSync(path.join(temp.dir, "runtime.pid.lock")), true);
    fs.rmSync(temp.dir, { recursive: true, force: true });
  });

  it("starts on localhost", async () => {
    const temp = runtimeFixture("m3-server-");
    server = new RuntimeServer({ ...temp, port: 0, authRequired: false, entitlementRequired: false });
    await server.start();
    assert.ok(server.port > 0);
  });

  it("GET /health returns 200", async () => {
    const r = await httpFetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "ok");
  });

  it("GET /api/v1/status returns entitlement + knowledge", async () => {
    const r = await httpFetch(`http://127.0.0.1:${server.port}/api/v1/status`);
    assert.equal(r.status, 200);
    assert.equal(typeof r.data.entitlement.valid, "boolean");
    assert.equal(typeof r.data.knowledge.outcomes, "number");
  });

  it("rejects non-loopback remote addresses before route handling", async () => {
    const original = server._handleRequest;
    const request = { socket: { remoteAddress: "192.0.2.1" }, method: "GET", url: "/api/v1/status" };
    const response = { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; return this; }, end(body) { this.body = body; } };
    await original.call(server, request, response);
    assert.equal(response.status, 403);
    assert.match(response.body, /localhost only/);
  });

  it("rejects missing, malformed, and invalid bearer credentials on MCP HTTP", async () => {
    const authTemp = runtimeFixture("m3-server-mcp-auth-");
    const authServer = new RuntimeServer({ ...authTemp, port: 0, entitlementRequired: false, runtimeToken: "runtime-secret" });
    await authServer.start();
    try {
      const url = `http://127.0.0.1:${authServer.port}/mcp`;
      const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } };
      for (const authorization of [undefined, "Basic runtime-secret", "Bearer", "Bearer wrong", "Bearer runtime-secret extra"]) {
        const headers = authorization === undefined ? {} : { Authorization: authorization };
        const r = await httpPost(url, message, headers);
        assert.equal(r.status, 401, authorization || "missing authorization");
      }
      const valid = await httpPost(url, message, { Authorization: "Bearer runtime-secret" });
      assert.equal(valid.status, 200);
      assert.equal(valid.data.result.serverInfo.name, "minitok-runtime");
    } finally {
      await authServer.stop();
      fs.rmSync(authTemp.dir, { recursive: true, force: true });
    }
  });

  it("allows MCP initialize but denies paid methods without entitlement", async () => {
    const entitlementTemp = runtimeFixture("m3-server-mcp-entitlement-");
    const denied = new RuntimeServer({ ...entitlementTemp, port: 0, runtimeToken: "runtime-secret", entitlementRequired: true });
    denied.services.entitlement.status = async () => ({ allowed: false, state: "SERVER_REJECTED", message: "Entitlement denied" });
    await denied.start();
    try {
      const url = `http://127.0.0.1:${denied.port}/mcp`;
      const init = await httpPost(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, { Authorization: "Bearer runtime-secret" });
      assert.equal(init.status, 200);
      assert.equal(typeof init.headers["mcp-session-id"], "string");
      const list = await httpPost(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { Authorization: "Bearer runtime-secret", "Mcp-Session-Id": init.headers["mcp-session-id"] });
      assert.equal(list.status, 200);
      assert.equal(list.data.error.data.type, "ENTITLEMENT_REQUIRED");
      assert.equal(list.data.error.data.state, "SERVER_REJECTED");
    } finally {
      await denied.stop();
      fs.rmSync(entitlementTemp.dir, { recursive: true, force: true });
    }
  });

  it("POST /api/v1/knowledge/query works", async () => {
    const r = await httpPost(`http://127.0.0.1:${server.port}/api/v1/knowledge/query`, {});
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.outcomes));
  });

  it("POST /api/v1/context/compact works", async () => {
    const r = await httpPost(`http://127.0.0.1:${server.port}/api/v1/context/compact`, { text: "hello" });
    assert.equal(r.status, 200);
    assert.equal(r.data.text, "hello");
  });

  it("POST /api/v1/context/compact rejects missing text", async () => {
    const r = await httpPost(`http://127.0.0.1:${server.port}/api/v1/context/compact`, {});
    assert.equal(r.status, 400);
  });

  it("POST /api/v1/observations/ingest works", async () => {
    const r = await httpPost(`http://127.0.0.1:${server.port}/api/v1/observations/ingest`, {
      project: "test", events: [{ type: "file_modified", path: "a.js", action: "modify" }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.accepted, 1);
  });

  it("GET unknown route returns 404", async () => {
    const r = await httpFetch(`http://127.0.0.1:${server.port}/api/v1/unknown`);
    assert.equal(r.status, 404);
  });

  it("stops cleanly", async () => {
    await server.stop();
  });

  it("confirms taskkill termination on Windows", { skip: process.platform !== "win32" }, () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      assert.equal(_waitForExit(child.pid), true);
    } finally {
      if (_waitForExit(child.pid, 1) === false) {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
      }
    }
  });
});

describe("M3 MCP Tools", () => {
  it("defines 15 tools, including the minitok_task facade", () => {
    const tools = getToolDefinitions();
    assert.equal(tools.length, 15);
    assert.ok(tools.some(tool => tool.name === "minitok_task"));
    const names = tools.map(t => t.name);
    assert.ok(names.includes("minitok_knowledge_query"));
    assert.ok(names.includes("minitok_knowledge_record"));
    assert.ok(names.includes("minitok_analyze_failures"));
    assert.ok(names.includes("minitok_recommend_policy"));
    assert.ok(names.includes("minitok_compact_context"));
    assert.ok(names.includes("minitok_collect_evidence"));
    assert.ok(names.includes("minitok_status"));
    assert.ok(names.includes("minitok_observe"));
  });

  it("each tool has inputSchema", () => {
    for (const tool of getToolDefinitions()) {
      assert.ok(tool.inputSchema, "Tool " + tool.name + " missing inputSchema");
      assert.equal(tool.inputSchema.type, "object");
    }
  });

  it("knowledge_query tool works", async () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    const r = await getToolHandler("minitok_knowledge_query", {}, svc);
    assert.ok(r.content);
    assert.ok(r.content[0].text);
    const data = JSON.parse(r.content[0].text);
    assert.ok(Array.isArray(data.outcomes));
  });

  it("compact tool works", async () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    const r = await getToolHandler("minitok_compact_context", { text: "hello world" }, svc);
    const data = JSON.parse(r.content[0].text);
    assert.equal(data.text, "hello world");
  });

  it("observe tool works", async () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    const r = await getToolHandler("minitok_observe", { events: [{ type: "file_modified", path: "a.js", action: "modify" }] }, svc);
    const data = JSON.parse(r.content[0].text);
    assert.equal(data.accepted, 1);
  });

  it("unknown tool throws", async () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    await assert.rejects(() => getToolHandler("unknown_tool", {}, svc), /Unknown tool/);
  });

  it("compact without text throws", async () => {
    const svc = createRuntimeServices({ knowledgePath: tempKnowledgePath().file });
    await assert.rejects(() => getToolHandler("minitok_compact_context", {}, svc), /text is required/);
  });
});

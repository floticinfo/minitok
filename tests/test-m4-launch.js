/** M4 - Launch Readiness Tests */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const fileUrl = pathToFileURL(__filename);
const { checkEntitlement, GateState } = require("../src/entitlement/gate.js");
const { getToolDefinitions, getToolHandler } = require("../src/mcp/tools.js");
const { RuntimeServer } = require("../src/runtime/test-seam.js");
const { ObservationService } = require("../src/runtime/observations.js");
const { cmdActivate } = require("../src/cli/commands/activate.js");
const { cmdStatus } = require("../src/cli/commands/status.js");
const { cmdCheckout } = require("../src/cli/commands/checkout.js");
const { cmdPortal } = require("../src/cli/commands/portal.js");
const { resolveServerUrl } = require("../src/cli/commands/server-config.js");
const H = "127.0.0.1";
function httpGet(u) { return new Promise((ok, no) => { const o = new URL(u); http.get({ hostname: o.hostname, port: o.port, path: o.pathname }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => ok({ s: r.statusCode, b: d })); }).on("error", no); }); }
function httpPost(u, body) { return new Promise((ok, no) => { const o = new URL(u), d = JSON.stringify(body); const q = http.request({ hostname: o.hostname, port: o.port, path: o.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } }, r => { let x = ""; r.on("data", c => x += c); r.on("end", () => { try { ok({ s: r.statusCode, b: JSON.parse(x) }); } catch { ok({ s: r.statusCode, b: x }); } }); }); q.on("error", no); q.write(d); q.end(); }); }
describe("M4.1 Security Boundaries", () => {
  it("no live payment keys in source", () => { const d = path.resolve(path.dirname(__filename), "../src"), f = []; function w(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith(".js") && !p.includes("test") && !p.includes("fixture")) f.push(p); } } w(d); for (const p of f) { const c = fs.readFileSync(p, "utf-8"); assert.ok(!c.includes("sk_live_"), p); assert.ok(!c.includes("whsec_"), p); } });
  it("Runtime binds localhost only", () => { const c = fs.readFileSync(path.join(__dirname, "../src/runtime/server.js"), "utf-8"); assert.ok(c.includes("127.0.0.1")); assert.ok(!c.includes("0.0.0.0")); });
  it("MCP no child_process", () => { const c = fs.readFileSync(path.join(__dirname, "../src/mcp/tools.js"), "utf-8"); assert.ok(!c.includes("child_process")); });
  it("Runtime no fs.watch", () => { for (const f of fs.readdirSync(path.join(__dirname, "../src/runtime")).filter(x => x.endsWith(".js"))) { const c = fs.readFileSync(path.join(__dirname, "../src/runtime", f), "utf-8"); assert.ok(!c.includes("fs.watch"), f); } });
  it("MCP no write/spawn", () => { const c = fs.readFileSync(path.join(__dirname, "../src/mcp/tools.js"), "utf-8"); assert.ok(!c.includes("writeFileSync")); assert.ok(!c.includes("spawn")); });
});

describe("M4.2 CLI Command Exports", () => {
  it("activate", () => assert.equal(typeof cmdActivate, "function"));
  it("status", () => assert.equal(typeof cmdStatus, "function"));
  it("checkout", () => assert.equal(typeof cmdCheckout, "function"));
  it("portal", () => assert.equal(typeof cmdPortal, "function"));
  it("server-config", () => assert.ok(resolveServerUrl().startsWith("http")));
});
describe("M4.3 Entitlement Gate", () => {
  it("returns MISSING", () => {
    const entitlementDir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-empty-entitlement-"));
    try {
      const result = checkEntitlement({ entitlementDir });
      assert.equal(result.state, GateState.MISSING);
      assert.equal(result.allowed, false);
    } finally {
      fs.rmSync(entitlementDir, { recursive: true, force: true });
    }
  });
  it("deterministic", () => {
    const entitlementDir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-deterministic-entitlement-"));
    try {
      assert.equal(checkEntitlement({ entitlementDir }).state, checkEntitlement({ entitlementDir }).state);
    } finally {
      fs.rmSync(entitlementDir, { recursive: true, force: true });
    }
  });
  it("no secrets leaked", () => { const s = JSON.stringify(checkEntitlement()); assert.ok(!s.includes("sk_live")); assert.ok(!s.includes("sk_test")); });
});
describe("M4.4 MCP Protocol", () => {
  it("current MCP tool surface is defined", () => {
    const names = getToolDefinitions().map(tool => tool.name);
    assert.equal(names.length, 21);
    for (const name of ["minitok_discover", "minitok_goal_start", "minitok_goal_status", "minitok_goal_continue", "minitok_goal_pause", "minitok_goal_resume", "minitok_goal_cancel"]) assert.ok(names.includes(name));
  });
  it("minitok_ prefix", () => { for (const t of getToolDefinitions()) assert.ok(t.name.startsWith("minitok_")); });
  it("valid schema", () => { for (const t of getToolDefinitions()) { assert.ok(t.inputSchema); assert.equal(t.inputSchema.type, "object"); } });
  it("status returns entitlement", async () => { const r = await getToolHandler("minitok_status", {}, { knowledge: { query: () => ({ outcomes: [], total: 0 }) }, entitlement: { status: async () => ({ state: "MISSING", allowed: false }) } }); assert.ok(JSON.parse(r.content[0].text).entitlement); });
  it("knowledge query", async () => { const r = await getToolHandler("minitok_knowledge_query", { limit: 5 }, { knowledge: { query: () => ({ outcomes: [], total: 0 }) } }); assert.ok(JSON.parse(r.content[0].text).outcomes !== undefined); });
  it("compact", async () => { const r = await getToolHandler("minitok_compact_context", { text: "hello" }, { compact: { compact: t => ({ text: t }) } }); assert.equal(JSON.parse(r.content[0].text).text, "hello"); });
  it("unknown throws", async () => { await assert.rejects(() => getToolHandler("bad", {}, {})); });
});
describe("M4.5 Runtime HTTP API", () => {
  async function ws(fn) {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-m4-runtime-"));
    const s = new RuntimeServer({
      runtimeDir,
      knowledgePath: path.join(runtimeDir, "knowledge.json"),
      entitlementDir: path.join(runtimeDir, "entitlement"),
      pidFile: path.join(runtimeDir, "runtime.pid"),
      tokenFile: path.join(runtimeDir, "runtime.token"),
      auditPath: path.join(runtimeDir, "audit.jsonl"),
      evidenceDirectory: path.join(runtimeDir, "evidence"),
      observationDir: path.join(runtimeDir, "observations"),
      port: 0,
       runtimeToken: "m4-runtime-token",
       authRequired: false,
       entitlementRequired: false,

    });
    await s.start();
    try { await fn(s); } finally { await s.stop(); fs.rmSync(runtimeDir, { recursive: true, force: true }); }
  }
  it("health 200", async () => await ws(async (s) => { assert.equal((await httpGet("http://" + H + ":" + s.port + "/health")).s, 200); }));
  it("status", async () => await ws(async (s) => { const r = await httpGet("http://" + H + ":" + s.port + "/api/v1/status"); assert.equal(r.s, 200); assert.ok(r.b.includes("entitlement")); }));
  it("knowledge query", async () => await ws(async (s) => { const r = await httpPost("http://" + H + ":" + s.port + "/api/v1/knowledge/query", { limit: 10 }); assert.equal(r.s, 200); const body = typeof r.b === "string" ? JSON.parse(r.b) : r.b; assert.ok(Array.isArray(body.outcomes)); }));
  it("knowledge record", async () => await ws(async (s) => { const r = await httpPost("http://" + H + ":" + s.port + "/api/v1/knowledge/record", { outcome: { goal: "t", status: "success", cycles: 1 } }); assert.equal(r.s, 200); const body = typeof r.b === "string" ? JSON.parse(r.b) : r.b; assert.equal(body.recorded, true); }));
  it("compact validates", async () => await ws(async (s) => { assert.equal((await httpPost("http://" + H + ":" + s.port + "/api/v1/context/compact", {})).s, 400); }));
  it("unknown route 404", async () => await ws(async (s) => { assert.equal((await httpGet("http://" + H + ":" + s.port + "/v1/nonexistent")).s, 404); }));
});
describe("M4.6 Standalone Independence", () => {
  it("loop.js no runtime imports", () => { const c = fs.readFileSync(path.join(__dirname, "../src/pipeline/loop.js"), "utf-8"); assert.ok(!c.includes("runtime")); assert.ok(!c.includes("mcp")); });
  it("entitlement standalone", () => { assert.ok(typeof checkEntitlement().state === "string"); assert.ok(typeof checkEntitlement().allowed === "boolean"); });
});
describe("M4.7 CLI Graceful Failure", () => {
  it("status", async () => assert.ok(typeof (await cmdStatus()) === "number"));
  it("activate bad", async () => assert.equal(await cmdActivate("BAD", { server: "http://" + H + ":19999" }), 1));
  it("checkout no token", async () => assert.equal(await cmdCheckout({}), 1));
  it("portal no token", async () => assert.equal(await cmdPortal({}), 1));
});
describe("M4.9 Dodo Production Checkout/Portal Paths", () => {
  it("checkout accepts only Open", async () => {
    assert.equal(await cmdCheckout({ plan: "select", token: "jwt" }), 1);
    assert.equal(await cmdCheckout({ plan: "private", token: "jwt" }), 1);
  });
  it("checkout defaults to /v1/checkout/dodo", () => {
    const c = fs.readFileSync(path.join(__dirname, "../src/cli/commands/checkout.js"), "utf-8");
    assert.ok(c.includes('const endpoint = "/v1/checkout/dodo"'), "checkout must default to Dodo endpoint");
  });
  it("checkout is Dodo-only", () => {
    const c = fs.readFileSync(path.join(__dirname, "../src/cli/commands/checkout.js"), "utf-8");
    assert.ok(c.includes('const endpoint = "/v1/checkout/dodo"'));
    assert.ok(!c.includes("/v1/checkout\""));
    assert.ok(!c.includes("--legacy-provider"));
  });
  it("portal is Dodo-only", () => {
    const c = fs.readFileSync(path.join(__dirname, "../src/cli/commands/portal.js"), "utf-8");
    assert.ok(c.includes('const endpoint = "/v1/portal/dodo"'));
    assert.ok(!c.includes("/v1/portal\""));
    assert.ok(!c.includes("--legacy-provider"));
  });
  it("bin exposes no legacy provider flag", () => {
    const c = fs.readFileSync(path.join(__dirname, "../bin/minitok.js"), "utf-8");
    assert.ok(!c.includes("--legacy-provider"));
  });
  it("bin registers activation-key command", () => {
    const c = fs.readFileSync(path.join(__dirname, "../bin/minitok.js"), "utf-8");
    assert.ok(c.includes("activation-key"), "bin must expose activation-key command");
  });
  it("activation-key command exists and handles missing token", async () => {
    const { cmdActivationKey } = require("../src/cli/commands/activation-key.js");
    assert.equal(typeof cmdActivationKey, "function");
    assert.equal(await cmdActivationKey({}), 1);
  });
});
describe("M4.8 Observations", () => {
  it("accepts", () => { const s = new ObservationService(); assert.equal(s.ingest({ project: "t", events: [{ type: "task_started", name: "test" }] }).accepted, 1); });
  it("empty rejected", () => assert.equal(new ObservationService().ingest({ events: [] }).accepted, 0));
  it("passive", () => { const s = new ObservationService(); assert.equal(typeof s.ingest, "function"); assert.equal(typeof s.watch, "undefined"); });
});

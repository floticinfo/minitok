"use strict";

/**
 * The client must talk to the routes the server actually serves.
 *
 * [2026-10-22 E단계] The client called the Phase 1 routes
 * `POST /api/entitlement/activate`, `GET /api/entitlement/status` and
 * `DELETE /api/entitlement`. The server stopped serving them, so
 * `minitok activate` — the command the website tells a paying customer to run
 * after a completed payment — answered `404 Route ... not found`, and
 * `minitok status` / `minitok deactivate` could not reach the server either.
 *
 * The canonical contract is the /v1 API. These tests pin the client's URL and
 * body shape against it, and assert that no client source refers to a Phase 1
 * entitlement route any more.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const client = require("../src/entitlement/client");
const { cmdActivate } = require("../src/cli/commands/activate");
const { ensureInstallationId, readInstallationRecord, writeInstallationRecord } = require("../src/auth/installation");
const { EntitlementStore } = require("../src/entitlement/store");
const { EntitlementCache } = require("../src/entitlement/cache");

const SERVER_URL = "https://api.minitok.test";
const LEGACY_ROUTES = ["/api/entitlement/activate", "/api/entitlement/status", "/api/entitlement/refresh", "/api/entitlement"];

function jsonResponse(body, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: { get: name => (name === "content-length" ? String(bytes.byteLength) : null) },
    body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
  };
}

function withFetchStub(responder, fn) {
  const saved = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return responder(calls);
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = saved; });
}


/** Every file under a directory, skipping the install and git directories. */
function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * The files the published tarball would contain.
 *
 * `npm pack --dry-run --json` lists exactly what the tarball carries, so the
 * shipped bytes are checked rather than the working tree: a file that is in the
 * repository but excluded from the package is not shipped, and a file that is
 * shipped must not carry a retired route.
 */
function packedFiles() {
  // npm is run through node, never through a shell: a shell would concatenate
  // the arguments into a command line, and this test needs no shell at all.
  const npmExecPath = process.env.npm_execpath
    || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const output = execFileSync(process.execPath, [npmExecPath, "pack", "--dry-run", "--json"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output);
  return parsed[0].files.map((file) => file.path);
}

function tempDir(name) {
  const dir = path.join(require("os").tmpdir(), `mt-ent-contract-${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("the entitlement client uses the canonical /v1 routes", () => {
  it("activates through POST /v1/activate", async () => {
    await withFetchStub(() => jsonResponse({ ok: true }), async (calls) => {
      await client.activate("key-1", { serverUrl: SERVER_URL, installationId: "11111111-1111-4111-8111-111111111111" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${SERVER_URL}/v1/activate`);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].body.key, "key-1");
      assert.equal(calls[0].body.installation_id, "11111111-1111-4111-8111-111111111111");
    });
  });

  it("validates through POST /v1/validate", async () => {
    await withFetchStub(() => jsonResponse({ valid: true }), async (calls) => {
      await client.status("jwt", { serverUrl: SERVER_URL, entitlement: { payload: {}, signature: "s", key_id: "k" } });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${SERVER_URL}/v1/validate`);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].body.token, "jwt");
      assert.equal(calls[0].body.entitlement.key_id, "k");
    });
  });

  it("deactivates through POST /v1/deactivate", async () => {
    await withFetchStub(() => jsonResponse({ success: true }), async (calls) => {
      await client.deactivate("jwt", { serverUrl: SERVER_URL });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${SERVER_URL}/v1/deactivate`);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].body.token, "jwt");
    });
  });

  it("no client source refers to a Phase 1 entitlement route", () => {
    const root = path.resolve(__dirname, "..");
    const walk = (dir) => {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", ".git"].includes(entry.name)) continue;
          out.push(...walk(full));
        } else if (entry.name.endsWith(".js")) {
          out.push(full);
        }
      }
      return out;
    };
    for (const file of walk(path.join(root, "src"))) {
      const content = fs.readFileSync(file, "utf8");
      for (const route of LEGACY_ROUTES) {
        assert.ok(
          !content.includes(route),
          `${path.relative(root, file)} must not call the retired route ${route}`,
        );
      }
    }
  });
});

describe("the installation identity is stable", () => {
  it("returns the same id on every call", () => {
    const dir = tempDir("stable");
    try {
      const first = ensureInstallationId(dir);
      const second = ensureInstallationId(dir);
      assert.equal(first, second);
      assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a bound record wins over the standalone id file", () => {
    const dir = tempDir("bound");
    try {
      const provisional = ensureInstallationId(dir);
      const bound = "22222222-2222-4222-8222-222222222222";
      writeInstallationRecord({ token: "jwt", installation_id: bound }, dir);
      assert.equal(ensureInstallationId(dir), bound);
      assert.notEqual(bound, provisional);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("minitok activate completes the canonical flow", () => {
  it("stores the entitlement, the installation record and the session", async () => {
    const dir = tempDir("activate");
    const artifact = {
      payload: { plan_id: "level1", expires_at: "2026-12-31T00:00:00Z", installation_id: "bound-by-server" },
      signature: "sig",
      key_id: "key-2026-09-prod",
    };
    const installationToken = "header." + Buffer.from(JSON.stringify({ exp: 1893456000, sub: "c" })).toString("base64url") + ".sig";
    try {
      await withFetchStub(() => jsonResponse({ entitlement: artifact, installation_token: installationToken }), async (calls) => {
        const code = await cmdActivate("key-1", { server: SERVER_URL, entitlementDir: dir });
        assert.equal(code, 0);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, `${SERVER_URL}/v1/activate`);
        // The client owns the installation identity: it must be a v4 uuid it
        // generated and persisted, not a value the caller supplied per request.
        assert.match(calls[0].body.installation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        assert.equal(calls[0].body.installation_id, ensureInstallationId(dir));
      });

      const stored = new EntitlementStore(dir).load();
      assert.equal(stored.payload.plan_id, "level1");
      assert.equal(stored.signature, "sig");
      const record = readInstallationRecord(dir);
      assert.equal(record.token, installationToken);
      // The server's payload carries the binding it issued; the record must
      // agree with it so the local gate's installation check passes.
      assert.equal(record.installation_id, artifact.payload.installation_id);
      assert.ok(new EntitlementCache(dir).load({ allowStale: true }), "the session cache must hold the installation token");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the server's refusal instead of a generic failure", async () => {
    const dir = tempDir("refused");
    try {
      await withFetchStub(() => jsonResponse({ error: "Activation key not found" }, 404), async () => {
        const code = await cmdActivate("key-bad", { server: SERVER_URL, entitlementDir: dir });
        assert.equal(code, 1);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("no shipped artifact carries a retired entitlement route", () => {
  it("the extension source and its build output name no retired route", () => {
    const root = path.resolve(__dirname, "..");
    for (const dir of [path.join(root, "extension", "src"), path.join(root, "extension", "dist")]) {
      if (!fs.existsSync(dir)) continue;
      for (const file of walkFiles(dir)) {
        if (!/\.(ts|js|mjs|html)$/.test(file)) continue;
        const content = fs.readFileSync(file, "utf8");
        for (const route of LEGACY_ROUTES) {
          assert.ok(
            !content.includes(route),
            `${path.relative(root, file)} must not carry the retired route ${route}`,
          );
        }
      }
    }
  });

  it("the published npm package names no retired route", () => {
    const root = path.resolve(__dirname, "..");
    const files = packedFiles();
    assert.ok(files.length > 50, `the pack must not be empty (got ${files.length} files)`);
    for (const rel of files) {
      if (!/\.(js|mjs|cjs|json|md)$/.test(rel)) continue;
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, "utf8");
      for (const route of LEGACY_ROUTES) {
        assert.ok(
          !content.includes(route),
          `the published package must not carry the retired route ${route} (${rel})`,
        );
      }
    }
  });
});

describe("a refusal is never reported as a success", () => {
  it("a 404 from the activation route fails the command", async () => {
    const dir = tempDir("notfound");
    try {
      await withFetchStub(() => jsonResponse({ error: "Route POST:/v1/activate not found" }, 404), async (calls) => {
        const code = await cmdActivate("key-1", { server: SERVER_URL, entitlementDir: dir });
        assert.equal(code, 1, "a 404 must fail the command, never report success");
        assert.equal(calls.length, 1);
      });
      assert.equal(new EntitlementStore(dir).load(), null, "a refused activation must not write an entitlement");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the server's machine-readable reason is surfaced", async () => {
    const dir = tempDir("reason");
    const errors = [];
    const saved = console.error;
    console.error = (...args) => { errors.push(args.join(" ")); };
    try {
      await withFetchStub(() => jsonResponse({ error: "Plan 'open' is not available for purchase", reason: "plan_not_purchasable" }, 409), async () => {
        const code = await cmdActivate("key-1", { server: SERVER_URL, entitlementDir: dir });
        assert.equal(code, 1);
      });
    } finally {
      console.error = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const printed = errors.join("\n");
    assert.match(printed, /plan_not_purchasable/, "the machine-readable reason must reach the user");
    assert.match(printed, /not available for purchase/, "the server's message must reach the user too");
  });
});

describe("the installation identity survives a refused attempt", () => {
  it("a retry presents the same installation id", async () => {
    const dir = tempDir("retry");
    try {
      const first = ensureInstallationId(dir);
      await withFetchStub(() => jsonResponse({ error: "Activation key not found" }, 404), async () => {
        const code = await cmdActivate("key-bad", { server: SERVER_URL, entitlementDir: dir });
        assert.equal(code, 1);
      });
      const second = ensureInstallationId(dir);
      assert.equal(second, first, "a failed attempt must not change the installation identity");
      assert.equal(
        readInstallationRecord(dir),
        null,
        "a refused activation must not bind an installation record",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

"use strict";

/**
 * Device-flow login polling regressions:
 *  - the polling loop must observe an AbortSignal so a caller (Ctrl-C handler,
 *    extension host shutdown) can stop the wait instead of blocking up to the
 *    full device-code lifetime,
 *  - a non-interactive invocation with no explicit timeout must stop quickly
 *    instead of polling for the full 10 minutes, because there is no user able
 *    to complete the browser step.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { accountLogin } = require("../src/cli/commands/account");

/** Start a stub device-flow server that always answers authorization_pending. */
function startStubServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/auth/device/authorize") {
        res.end(JSON.stringify({ device_code: "test-device", verification_uri: "https://example.invalid/activate", interval: 1 }));
        return;
      }
      if (req.url === "/v1/auth/device/token") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "authorization_pending" }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

test("device-flow polling stops when the abort signal fires", async () => {
  const server = await startStubServer();
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 250);
    const code = await accountLogin({ server: url, openBrowser: false, timeoutMs: 60000, signal: controller.signal });
    const elapsed = Date.now() - started;
    assert.equal(code, 1);
    assert.ok(elapsed < 10000, `polling should stop shortly after abort, took ${elapsed}ms`);
  } finally {
    await closeServer(server);
  }
});

test("device-flow polling returns immediately when the signal is already aborted", async () => {
  const server = await startStubServer();
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const controller = new AbortController();
    controller.abort();
    const code = await accountLogin({ server: url, openBrowser: false, signal: controller.signal });
    assert.equal(code, 1);
  } finally {
    await closeServer(server);
  }
});

test("device-flow polling honors an explicit timeout", async () => {
  const server = await startStubServer();
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const started = Date.now();
    const code = await accountLogin({ server: url, openBrowser: false, timeoutMs: 1500 });
    const elapsed = Date.now() - started;
    assert.equal(code, 1);
    assert.ok(elapsed < 15000, `polling should stop near the timeout, took ${elapsed}ms`);
  } finally {
    await closeServer(server);
  }
});

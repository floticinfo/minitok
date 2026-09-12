"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { shouldBypassProxy } = require("./http");

function withNoProxy(value, run) {
  const previousUpper = process.env.NO_PROXY;
  const previousLower = process.env.no_proxy;
  delete process.env.no_proxy;
  process.env.NO_PROXY = value;
  try { run(); } finally {
    if (previousUpper === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previousUpper;
    if (previousLower !== undefined) process.env.no_proxy = previousLower;
  }
}

describe("shouldBypassProxy", () => {
  it("matches exact hosts and leading-dot domain suffixes", () => {
    withNoProxy("localhost,127.0.0.1,.internal.example", () => {
      assert.equal(shouldBypassProxy("http://localhost:4580/v1/activate"), true);
      assert.equal(shouldBypassProxy("http://127.0.0.1:4580/v1/activate"), true);
      assert.equal(shouldBypassProxy("https://internal.example/v1"), true);
      assert.equal(shouldBypassProxy("https://api.internal.example/v1"), true);
      assert.equal(shouldBypassProxy("https://api.example/v1"), false);
    });
  });

  it("matches an IPv4 CIDR block", () => {
    withNoProxy("10.0.0.0/8,192.168.1.0/24", () => {
      assert.equal(shouldBypassProxy("https://10.4.5.6/v1"), true);
      assert.equal(shouldBypassProxy("https://192.168.1.200/v1"), true);
      assert.equal(shouldBypassProxy("https://192.168.2.200/v1"), false);
      assert.equal(shouldBypassProxy("https://11.0.0.1/v1"), false);
    });
  });

  it("honours host:port entries only for the matching port", () => {
    withNoProxy("registry.internal:8443", () => {
      assert.equal(shouldBypassProxy("https://registry.internal:8443/v1"), true);
      assert.equal(shouldBypassProxy("https://registry.internal/v1"), false);
      assert.equal(shouldBypassProxy("https://registry.internal:9443/v1"), false);
    });
  });

  it("uses the default port when the URL omits one", () => {
    withNoProxy("registry.internal:443", () => {
      assert.equal(shouldBypassProxy("https://registry.internal/v1"), true);
    });
  });

  it("matches a bracketed IPv6 literal", () => {
    withNoProxy("[::1]", () => {
      assert.equal(shouldBypassProxy("http://[::1]:4580/v1"), true);
      assert.equal(shouldBypassProxy("http://[::2]:4580/v1"), false);
    });
  });

  it("treats * as bypass everything and ignores empty entries", () => {
    withNoProxy(" , *,", () => {
      assert.equal(shouldBypassProxy("https://anything.example/v1"), true);
    });
  });

  it("returns false when NO_PROXY is unset or the URL is invalid", () => {
    const previous = process.env.NO_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      assert.equal(shouldBypassProxy("https://api.example/v1"), false);
      process.env.NO_PROXY = "api.example";
      assert.equal(shouldBypassProxy("not a url"), false);
    } finally {
      if (previous === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previous;
    }
  });
});

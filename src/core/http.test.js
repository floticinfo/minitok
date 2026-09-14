"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { fetchWithTimeout, readCappedResponse } = require("./http");

function headers() {
  return { get: () => null };
}

describe("fetchWithTimeout", () => {
  it("clears its timeout when status and headers are inspected on a bodyless response", async () => {
    const originalFetch = global.fetch;
    let signal;
    global.fetch = async (_url, options) => {
      signal = options.signal;
      return { status: 204, statusText: "No Content", ok: true, headers: headers(), body: null };
    };
    try {
      const response = await fetchWithTimeout("https://example.test", {}, 20);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("content-type"), null);
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(signal.aborted, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("clears its timeout immediately for a status-only bodyless response", async () => {
    const originalFetch = global.fetch;
    let signal;
    global.fetch = async (_url, options) => {
      signal = options.signal;
      return { status: 204, body: null };
    };
    try {
      const response = await fetchWithTimeout("https://example.test", {}, 20);
      assert.equal(response.status, 204);
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(signal.aborted, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("clears its timeout when readCappedResponse rejects for a bodyless response", async () => {
    const originalFetch = global.fetch;
    let signal;
    global.fetch = async (_url, options) => {
      signal = options.signal;
      return { headers: headers(), body: null };
    };
    try {
      const response = await fetchWithTimeout("https://example.test", {}, 20);
      await assert.rejects(() => readCappedResponse(response), /HTTP response body is unavailable/);
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(signal.aborted, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("keeps its timeout through normal body consumption", async () => {
    const originalFetch = global.fetch;
    let signal;
    const stream = new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    global.fetch = async (_url, options) => {
      signal = options.signal;
      return { headers: headers(), body: stream };
    };
    try {
      const response = await fetchWithTimeout("https://example.test", {}, 20);
      assert.equal(await readCappedResponse(response), "{}");
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(signal.aborted, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("decodes a multi-byte UTF-8 character split across stream chunks", async () => {
    const originalFetch = global.fetch;
    const text = "한국어";
    const bytes = Buffer.from(text, "utf8");
    // Split the first character ("한", 3 bytes) after its first byte so the
    // multibyte sequence straddles the chunk boundary.
    const stream = new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 1));
        controller.enqueue(bytes.subarray(1));
        controller.close();
      },
    });
    global.fetch = async (_url, options) => ({ headers: headers(), body: stream });
    try {
      const response = await fetchWithTimeout("https://example.test", {}, 20);
      assert.equal(await readCappedResponse(response), text);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("maps an abort during response body consumption to AuthError", async () => {
    const originalFetch = global.fetch;
    const reader = {
      read: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
      cancel: async () => {},
      releaseLock: () => {},
    };
    global.fetch = async () => ({ headers: headers(), body: { getReader: () => reader } });
    try {
      const response = await fetchWithTimeout("https://example.test", {}, 10);
      await assert.rejects(() => readCappedResponse(response), error => error.name === "AuthError" && error.message === "Authentication request timed out");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

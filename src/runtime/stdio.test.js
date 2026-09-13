"use strict";

/**
 * Stdio framing unit tests.
 *
 * The HTTP transport caps a request body, while stdio used to buffer an
 * unlimited line: a client that never sent a newline could grow the buffer until
 * the process ran out of memory.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { drainStdioLines, MAX_REQUEST_BYTES } = require("./stdio");

describe("stdio framing", () => {
  it("returns complete lines and keeps the incomplete remainder", () => {
    const first = drainStdioLines("", '{"id":1}\n{"id":2}\n{"id":3');
    assert.deepEqual(first.lines, ['{"id":1}', '{"id":2}']);
    assert.equal(first.rest, '{"id":3');
    assert.equal(first.oversized, false);

    const second = drainStdioLines(first.rest, '}\n');
    assert.deepEqual(second.lines, ['{"id":3}']);
    assert.equal(second.rest, "");
  });

  it("handles a chunk boundary that splits a line", () => {
    const a = drainStdioLines("", '{"id":');
    const b = drainStdioLines(a.rest, '1}\n');
    assert.deepEqual(b.lines, ['{"id":1}']);
    assert.equal(b.rest, "");
  });

  it("refuses an incomplete line above the cap instead of buffering it", () => {
    const oversized = drainStdioLines("", "x".repeat(MAX_REQUEST_BYTES + 1));
    assert.equal(oversized.oversized, true);
    assert.deepEqual(oversized.lines, []);
    assert.equal(oversized.rest, "", "the oversized payload is dropped");
  });

  it("still delivers the complete lines that preceded an oversized one", () => {
    const oversized = drainStdioLines("", `{"id":1}\n${"y".repeat(MAX_REQUEST_BYTES + 1)}`);
    assert.deepEqual(oversized.lines, ['{"id":1}']);
    assert.equal(oversized.oversized, true);
  });

  it("accepts a payload at exactly the cap", () => {
    const atCap = drainStdioLines("", "z".repeat(MAX_REQUEST_BYTES));
    assert.equal(atCap.oversized, false);
    assert.equal(atCap.rest.length, MAX_REQUEST_BYTES);
  });
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "scripts", "mcp-live-readiness.mjs"), "utf8");

test("live readiness keeps check status separate from HTTP status", () => {
  assert.match(SOURCE, /status: checkStatus/);
  assert.match(SOURCE, /httpStatus: result\.status/);
  assert.doesNotMatch(SOURCE, /results\.push\(\{ endpoint: pathname, status, \.\.\.result \}\)/);
});

// The production probe is intentionally not imported here: importing it would
// contact the network during the normal unit-test suite. The executable probe
// is run separately by `npm run readiness:mcp:live`.
void vm;

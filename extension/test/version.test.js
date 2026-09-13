"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Behavioural coverage for the gate every extension command depends on. The
// compiled module is required so the real implementation runs, not a copy of it.
const { isCliCompatible, MINIMUM_CLI_MAJOR, MINIMUM_CLI_MINOR } = require(path.join(__dirname, "..", "dist", "src", "version.js"));
const cliEntry = path.join(__dirname, "..", "..", "bin", "minitok.js");

test("accepts every supported CLI version, including the next major", () => {
  for (const version of ["1.3.0", "1.3.12", "1.4.0", "1.10.2", "2.0.0", "2.1.0", "3.3.1", "v1.3.5"]) {
    assert.equal(isCliCompatible(version), true, `${version} must be compatible`);
  }
});

test("rejects versions below the minimum and malformed input", () => {
  for (const version of ["0.9.9", "1.0.0", "1.2.9", "1.2", "", "not-a-version", null, undefined]) {
    assert.equal(isCliCompatible(version), false, `${JSON.stringify(version)} must be rejected`);
  }
});

test("accepts the exact string the CLI prints for --version", () => {
  // `minitok --version` prints "minitok 1.3.12". A gate that required a leading
  // digit rejected that string and made every `minitok.status` command fail.
  const output = execFileSync(process.execPath, [cliEntry, "--version"], { encoding: "utf8" });
  assert.match(output, /^minitok \d+\.\d+\.\d+/);
  assert.equal(isCliCompatible(output), true, `the extension must accept ${JSON.stringify(output.trim())}`);
});

test("the minimum supported version is documented as major.minor", () => {
  assert.equal(MINIMUM_CLI_MAJOR, 1);
  assert.equal(MINIMUM_CLI_MINOR, 3);
  assert.equal(isCliCompatible(`${MINIMUM_CLI_MAJOR}.${MINIMUM_CLI_MINOR}.0`), true);
  assert.equal(isCliCompatible(`${MINIMUM_CLI_MAJOR}.${MINIMUM_CLI_MINOR - 1}.99`), false);
});

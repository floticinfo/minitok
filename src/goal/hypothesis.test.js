"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createHypothesis,
  validateHypothesis,
  createAssumption,
  validateAssumption,
  decisionForAssumption,
  createLedger,
  validateLedger,
  appendLedgerEvent,
  transitionAssumption,
  replanMetadata,
  serializeLedger,
  deserializeLedger,
  migrateLedger,
} = require("./hypothesis");

function assumption(overrides = {}) {
  const value = createAssumption({ statement: "The repository uses local verification", source: "inferred", confidence: 0.8, risk_level: "low", affects_steps: ["observe", "verify"], invalidation_signals: ["remote-only verifier"], ...overrides });
  assert.equal(validateAssumption(value).valid, true);
  return value;
}
function hypothesis(overrides = {}) {
  const value = createHypothesis({ statement: "The target is within the workspace", basis: "explicit path and repository observation", source: "inferred", confidence: 0.8, impact_if_wrong: "low", reversibility: "reversible", ...overrides });
  assert.equal(validateHypothesis(value).valid, true);
  return value;
}

test("low-risk assumptions can auto-accept only in unrestricted_general", () => {
  const value = assumption();
  assert.deepEqual(decisionForAssumption(value, { mode: "unrestricted_general" }), { status: "accepted", requires_confirmation: false, reason: "low-risk assumption is eligible for unrestricted_general auto-accept" });
  assert.equal(decisionForAssumption(value, { mode: "safe" }).requires_confirmation, true);
});

test("high-impact assumptions require confirmation", () => {
  const value = assumption({ risk_level: "high", confirmation_policy: "require_user_confirmation" });
  assert.equal(decisionForAssumption(value, { mode: "unrestricted_general" }).status, "confirmation_required");
  const ledger = createLedger({ assumptions: [value] });
  assert.throws(() => transitionAssumption(ledger, value.assumption_id, "accepted", { reason: "not confirmed" }), error => error.code === "ASSUMPTION_CONFIRMATION_REQUIRED");
  assert.equal(transitionAssumption(ledger, value.assumption_id, "accepted", { confirmed: true }).assumptions[0].status, "accepted");
});

test("invalidation appends history and requires re-planning", () => {
  const value = assumption({ risk_level: "medium", confirmation_policy: "require_user_confirmation" });
  const ledger = createLedger({ assumptions: [value], hypotheses: [hypothesis()] });
  const next = transitionAssumption(ledger, value.assumption_id, "invalidated", { reason: "Observed remote-only verifier", evidence_ids: ["evidence_1"] });
  assert.equal(next.assumptions[0].status, "invalidated");
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].event_type, "assumption_invalidated");
  assert.deepEqual(next.history[0].replan, { required: true, affected_steps: ["observe", "verify"], reason: "Observed remote-only verifier" });
  assert.deepEqual(replanMetadata(next, "new observation", ["verify"], ["evidence_2"]), { required: true, reason: "new observation", affected_steps: ["verify"], evidence_ids: ["evidence_2"] });
});

test("distinguishes facts, inferred hypotheses, and assumptions", () => {
  const fact = hypothesis({ source: "observed", status: "accepted", basis: "evidence:e1" });
  const inferred = hypothesis({ source: "inferred", status: "proposed" });
  const ledger = createLedger({ hypotheses: [fact, inferred], assumptions: [assumption()] });
  assert.equal(ledger.hypotheses[0].source, "observed");
  assert.equal(ledger.hypotheses[1].source, "inferred");
  assert.equal(ledger.assumptions[0].source, "inferred");
});

test("ledger history is append-only and serialization is migration-compatible", () => {
  const ledger = createLedger({ assumptions: [assumption()], hypotheses: [hypothesis()] });
  const next = appendLedgerEvent(ledger, { event_type: "assumption_status_changed", record_id: ledger.assumptions[0].assumption_id, from_status: "proposed", to_status: "accepted", reason: "confirmed" });
  assert.equal(next.history.length, 1);
  assert.equal(validateLedger(next).valid, true);
  assert.deepEqual(deserializeLedger(serializeLedger(next)), next);
  const migrated = migrateLedger({ assumptions: [{ statement: "legacy assumption", source: "inferred", confidence: 0.5, risk_level: "low", affects_steps: [], invalidation_signals: [] }] });
  assert.equal(validateLedger(migrated).valid, true);
  assert.equal(migrated.assumptions.length, 1);
});

test("redacts sensitive values and rejects dangerous keys", () => {
  const value = assumption({ statement: "Use password=secret-value only for verification" });
  assert.doesNotMatch(JSON.stringify(value), /secret-value/);
  const bad = { ...value, statement: "safe", __proto__: { polluted: true } };
  assert.equal(validateAssumption(bad).valid, false);
});

test("source and extension runtime implementations remain identical", () => {
  const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  assert.equal(read(path.join(__dirname, "hypothesis.js")), read(path.join(__dirname, "..", "..", "extension", "runtime", "src", "goal", "hypothesis.js")));
});

"use strict";

/**
 * Failure pattern analyzer — deterministic failure categorization.
 *
 * Mirrors Python version's optimization/analyzer.py:
 * analyzes accumulated outcomes to detect patterns and suggest improvements.
 */

const _TIMEOUT_THRESHOLD = 3;
const _LOW_SUCCESS_RATE = 0.5;

/**
 * Keyword map for category detection.
 *
 * `type_error` MUST appear before `validation` because `validation`
 * contains the broad keyword "type". Compiler/mypy/tsc diagnostics
 * carry their own specific markers (see _TYPE_ERROR_KEYWORDS) so this
 * ordering only re-routes compiler output into the dedicated
 * TYPE_ERROR bucket; generic "type" mentions still fall through to
 * `validation`.
 */
const _CATEGORY_KEYWORDS = {
  type_error: ["mypy", "tsc", "ts23", "ts24", "ts25", "ts27", "ts28", "incompatible type", "incompatible return", "not assignable", "no overload", "does not exist on type", "argument of type", "expected type", "cannot find name"],
  lint: ["lint", "eslint", "style", "format"],
  test: ["test", "assertion", "expect", "assert"],
  validation: ["validation", "schema", "type", "typecheck"],
  syntax: ["syntax", "parse", "unexpected token"],
  import: ["import", "require", "module not found", "cannot find module"],
  timeout: ["timeout", "timed out", "deadline exceeded"],
  api_error: ["api", "rate limit", "429", "500", "503"],
};

/**
 * Failure categories that indicate structural/complexity problems rather
 * than incidental mistakes. Repeated or single occurrences of these warrant
 * escalating to a reasoning/heavy model tier (fast → heavy).
 */
const HIGH_COMPLEXITY_CATEGORIES = new Set(["type_error", "syntax", "import", "timeout"]);

/**
 * All recognized failure categories, in priority order.
 */
const FAILURE_CATEGORIES = ["type_error", "lint", "test", "validation", "syntax", "import", "timeout", "api_error", "unknown"];

/**
 * Dedicated repair strategies per category.
 *
 * TYPE_ERROR carries mypy/tsc-specific guidance so the implementer
 * (and the human reviewer) knows exactly how to resolve compiler
 * diagnostics without guesswork.
 */
const REPAIR_STRATEGIES = {
  type_error: [
    "Run the static type checker to localize the diagnostic: `mypy --strict <file>` or `tsc --noEmit -p tsconfig.json`.",
    "Inspect the reported line: reconcile the inferred type with the expected type (argument type, return type, or property type).",
    "For mypy: add explicit type annotations to function signatures and variables; annotate the offending parameter or return value.",
    "For tsc: add explicit parameter/return types and fix TS error codes (e.g. TS2339 missing property, TS2345 incompatible argument, TS2322 type assignment).",
    "If the mismatch stems from a missing import or wrong generic parameterization, import the correct symbol or fix the type variable.",
  ],
  lint: [
    "Re-run the linter (`eslint .` or `prettier --check .`) to reproduce the reported style/import violations.",
    "Apply the formatter and fix unused variables, missing semicolons, and import order.",
  ],
  test: [
    "Re-run the failing test suite with verbose output to capture the exact assertion and expected vs actual values.",
    "Fix the assertion or the implementation logic; add a regression test if the failure was previously untested.",
  ],
  validation: [
    "Validate the changed data against the schema (e.g. `ajv`, `pydantic`) and correct field types or required keys.",
    "Check for missing properties or coercion mismatches between the producer and the schema.",
  ],
  syntax: [
    "Run the language parser/compiler (`node --check`, `python -m py_compile`) to surface the parse error location.",
    "Fix the offending line (unexpected token, unbalanced bracket, or indentation) and re-parse.",
  ],
  import: [
    "Verify the module path and that the dependency is installed (`npm ls <pkg>`, `pip show <pkg>`).",
    "Add the missing import statement or correct the relative path; re-run the build.",
  ],
  timeout: [
    "Reduce the operation scope: chunk large inputs, add pagination, and raise the configured timeout.",
    "Profile the slow path and cut redundant work (duplicate requests, re-issued context).",
  ],
  api_error: [
    "Inspect the provider error code (429/5xx) and honor Retry-After; back off and retry with a shorter request.",
    "Fall back to an alternative provider/model when available; cap request size.",
  ],
  unknown: [
    "Inspect the raw failure output and the verification command result; classify manually.",
    "Narrow the change to a minimal diff and re-verify incrementally.",
  ],
};

/**
 * Categorize a failure message into a category.
 * @param {string} message
 * @returns {string} category
 */
function categorizeFailure(message) {
  const lower = (message || "").toLowerCase();
  for (const [category, keywords] of Object.entries(_CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return "unknown";
}

/**
 * Analyze failure patterns from stored outcomes.
 * @param {Array} outcomes - array of EvolutionOutcome records
 * @returns {{ patterns: Array<{ category: string, count: number, last_occurrence: string }>, recommendations: string[] }}
 */
function analyzeFailurePatterns(outcomes) {
  const records = Array.isArray(outcomes) ? outcomes : [];
  const failures = records.filter(o => o.status !== "success");
  const successes = records.filter(o => o.status === "success");
  if (failures.length === 0 && successes.length === 0) {
    return { patterns: [], recommendations: [] };
  }

  // Count by category. `_success` is an internal policy signal rather than a
  // failure category; it lets sustained success reduce the next run's cycle
  // budget without changing the failure-pattern categories exposed to repair.
  const categoryCounts = {};
  if (successes.length > 0) categoryCounts._success = { count: successes.length, last_occurrence: successes.at(-1)?.timestamp };
  for (const f of failures) {
    const cat = f.failure_category || categorizeFailure(f.summary || "");
    if (!categoryCounts[cat]) categoryCounts[cat] = { count: 0, last_occurrence: f.timestamp };
    categoryCounts[cat].count++;
    if (f.timestamp > categoryCounts[cat].last_occurrence) {
      categoryCounts[cat].last_occurrence = f.timestamp;
    }
  }

  const patterns = Object.entries(categoryCounts)
    .map(([category, data]) => ({ category, ...data }))
    .sort((a, b) => b.count - a.count);

  // Generate recommendations
  const recommendations = [];
  const totalRuns = records.length;
  const totalFailures = failures.length;
  const successRate = 1 - (totalFailures / totalRuns);

  if (successRate < _LOW_SUCCESS_RATE) {
    recommendations.push(`Low success rate (${(successRate * 100).toFixed(0)}%). Consider increasing max_cycles or retry_backoff_sec.`);
  }

  const timeoutFailures = categoryCounts.timeout?.count || 0;
  if (timeoutFailures >= _TIMEOUT_THRESHOLD) {
    recommendations.push(`${timeoutFailures} timeout failures detected. Consider increasing timeout_sec.`);
  }

  const apiErrors = categoryCounts.api_error?.count || 0;
  if (apiErrors >= 2) {
    recommendations.push(`${apiErrors} API errors detected. Consider adding provider fallback or reducing request frequency.`);
  }

  return { patterns, recommendations };
}

/**
 * FailureAnalyzer — classifies a failure message and returns a dedicated
 * repair strategy, with mypy/tsc-aware handling for TYPE_ERROR.
 */
class FailureAnalyzer {
  constructor(options = {}) {
    this.keywords = options.keywords || _CATEGORY_KEYWORDS;
    this.strategies = options.strategies || REPAIR_STRATEGIES;
    this.highComplexity = options.highComplexity || HIGH_COMPLEXITY_CATEGORIES;
  }

  /** Classify a failure message. */
  categorize(message) {
    return categorizeFailure(message);
  }

  /** Return the dedicated repair strategy for a message (or a raw category). */
  suggestRepair(messageOrCategory) {
    const category = this._isCategory(messageOrCategory)
      ? messageOrCategory
      : this.categorize(messageOrCategory);
    return this.strategies[category] || this.strategies.unknown || [];
  }

  /** Full analysis: category, repair strategies, and complexity flags. */
  analyze(message) {
    const category = this.categorize(message);
    const repairStrategies = this.strategies[category] || this.strategies.unknown || [];
    return {
      category,
      repairStrategies,
      highComplexity: this.highComplexity.has(category),
      isTypeError: category === "type_error",
    };
  }

  _isCategory(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(this.keywords, value);
  }
}

module.exports = {
  analyzeFailurePatterns,
  categorizeFailure,
  FailureAnalyzer,
  REPAIR_STRATEGIES,
  HIGH_COMPLEXITY_CATEGORIES,
  FAILURE_CATEGORIES,
  _CATEGORY_KEYWORDS,
};

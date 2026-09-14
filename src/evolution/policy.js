"use strict";

const { HIGH_COMPLEXITY_CATEGORIES } = require("./analyzer");

/**
 * Adaptive policy engine — recommends execution policy adjustments.
 *
 * Mirrors Python version's optimization/policy.py:
 * analyzes failure patterns and recommends timeout/retry/cycle adjustments.
 */

const _MAX_TIMEOUT = 900;
const _MAX_CYCLES = 5;
const _MIN_RETRIES = 0;
const _TIMEOUT_INCREASE_FACTOR = 1.3;

/**
 * Recommend policy adjustments based on failure patterns.
 * @param {Array} patterns - from analyzer.analyzeFailurePatterns
 * @param {object} currentPolicy - { timeout_sec, max_retries, max_cycles }
 * @returns {{ recommended: object, reasons: string[] }}
 */
function recommendPolicy(patterns, currentPolicy = {}) {
  const reasons = [];
  const recommended = {
    timeout_sec: currentPolicy.timeout_sec || 600,
    max_retries: currentPolicy.max_retries || 3,
    max_cycles: currentPolicy.max_cycles || 3,
  };

  for (const pattern of (patterns || [])) {
    if (pattern.category === "timeout" && pattern.count >= 3) {
      const newTimeout = Math.min(
        Math.round(recommended.timeout_sec * _TIMEOUT_INCREASE_FACTOR),
        _MAX_TIMEOUT
      );
      if (newTimeout > recommended.timeout_sec) {
        recommended.timeout_sec = newTimeout;
        reasons.push(`Timeout increased to ${newTimeout}s (${pattern.count} timeout failures)`);
      }
    }

    if (pattern.category === "api_error" && pattern.count >= 2) {
      recommended.max_retries = Math.min(recommended.max_retries + 1, 5);
      reasons.push(`Retries increased to ${recommended.max_retries} (${pattern.count} API errors)`);
    }

    if (pattern.category === "test" && pattern.count >= 3) {
      recommended.max_cycles = Math.min(recommended.max_cycles + 1, _MAX_CYCLES);
      reasons.push(`Max cycles increased to ${recommended.max_cycles} (${pattern.count} test failures need more iterations)`);
    }
  }

  // Decrease on sustained success — `_success` is emitted by the analyzer as
  // an internal aggregate alongside failure patterns.
  const successRate = patterns?.length
    ? (patterns.find(p => p.category === "_success")?.count || 0) /
      patterns.reduce((s, p) => s + p.count, 0)
    : 0;
  if (successRate >= 0.8 && patterns?.length) {
    const newCycles = Math.max(recommended.max_cycles - 1, 1);
    if (newCycles < recommended.max_cycles) {
      recommended.max_cycles = newCycles;
      reasons.push(`Max cycles decreased to ${newCycles} (${Math.round(successRate * 100)}% success rate)`);
    }
  }

  // Enforce minimums
  recommended.max_retries = Math.max(recommended.max_retries, _MIN_RETRIES);
  recommended.max_cycles = Math.max(recommended.max_cycles, 1);

  return { recommended, reasons };
}

/**
 * Default model-tier escalation chain, ordered from cheapest to most capable.
 * Used to step a role up one tier on repeated failure, or to jump straight
 * to the "reasoning" tier for high-complexity errors.
 */
const DEFAULT_TIER_CHAIN = ["fast", "balanced", "flagship", "frontier", "reasoning"];

/**
 * EscalationEngine — model escalation + token hard guardrail.
 *
 * Mirrors Python version's orchestrator/escalation.py:
 * after N successive failures (or a single high-complexity error) the
 * work adapter is switched to a higher-tier model. When the token
 * hard limit is approached the loop is stopped and escalated to a human
 * rather than merely compressing context and retrying.
 */
class EscalationEngine {
  constructor(options = {}) {
    this.failureThreshold = Number(options.failureThreshold) || 2;
    this.tokenHardLimit = Number(options.tokenHardLimit) || 2_000_000;
    this.tokenStopRatio = Number(options.tokenStopRatio) || 0.9;
    this.tierChain = options.tierChain || DEFAULT_TIER_CHAIN;
    /** Explicit per-role escalation models (config-driven override). */
    this.escalationModels = options.escalationModels || {};
    /** (targetTier) => modelId | null. Bound to the work provider by the loop. */
    this.modelResolver = options.modelResolver || (() => null);
    this._state = new Map();
    /** Role whose adapter/model is escalated (typically "work" — the implementer). */
    this.role = options.role || "work";
  }

  _ctx(goalKey) {
    if (!this._state.has(goalKey)) {
      this._state.set(goalKey, {
        consecutiveFailures: 0,
        tierIndex: 0,
        escalated: false,
        totalTokens: 0,
        lastCategory: "unknown",
      });
    }
    return this._state.get(goalKey);
  }

  reset(goalKey) {
    this._state.delete(goalKey);
  }

  /** Hard guardrail: true when token usage is at/over the stop ratio. */
  shouldStop(tokens) {
    return tokens >= this.tokenHardLimit * this.tokenStopRatio;
  }

  /**
   * Record a cycle's outcome and return the escalation decision.
   * @param {string} goalKey
   * @param {{ success: boolean, category?: string, tokens?: number }} outcome
   * @returns {{ escalate: boolean, stop: boolean, humanEscalation: boolean, targetTier?: string, model?: string|null, reason?: string, stopReason?: string }}
   */
  recordCycleOutcome(goalKey, outcome = /** @type {{ success: boolean, category?: string, tokens?: number }} */ ({ success: false })) {
    const ctx = this._ctx(goalKey);
    ctx.lastCategory = outcome.category || "unknown";
    ctx.totalTokens += outcome.tokens || 0;

    // 1) Token hard guardrail — fires regardless of cycle success (beyond compression).
    if (this.shouldStop(ctx.totalTokens)) {
      return {
        escalate: false,
        stop: true,
        humanEscalation: true,
        reason: "token_exhausted",
        stopReason: `Token hard limit approached (${ctx.totalTokens.toLocaleString()} tokens). Stopping and escalating to a human reviewer instead of compressing context and retrying.`,
      };
    }

    if (outcome.success) {
      ctx.consecutiveFailures = 0;
      ctx.tierIndex = 0;
      ctx.escalated = false;
      return { escalate: false, stop: false, humanEscalation: false };
    }

    ctx.consecutiveFailures += 1;

    // 2) Model escalation after N failures or on a high-complexity error.
    const highComplexity = HIGH_COMPLEXITY_CATEGORIES.has(ctx.lastCategory);
    const thresholdMet = ctx.consecutiveFailures >= this.failureThreshold;
    if (!ctx.escalated && (thresholdMet || highComplexity)) {
      const targetTier = highComplexity ? "reasoning" : this._stepUpTier(ctx.tierIndex);
      const tierIndex = this.tierChain.indexOf(targetTier);
      const model = this.resolveModel(this.role, targetTier);
      ctx.tierIndex = tierIndex;
      // Cap at the reasoning tier — do not escalate beyond it.
      ctx.escalated = targetTier === "reasoning" || tierIndex >= this.tierChain.length - 1;
      ctx.consecutiveFailures = 0; // re-evaluate after the next N failures
      return {
        escalate: true,
        stop: false,
        humanEscalation: false,
        targetTier,
        model,
        reason: highComplexity
          ? `High-complexity ${ctx.lastCategory} error — escalating to reasoning model tier.`
          : `Repeated failures (≥${this.failureThreshold}) — escalating model tier → ${targetTier}.`,
      };
    }

    return {
      escalate: false,
      stop: false,
      humanEscalation: false,
      reason: highComplexity ? `High-complexity ${ctx.lastCategory} flagged, awaiting escalation window.` : undefined,
    };
  }

  _stepUpTier(currentIndex) {
    return this.tierChain[Math.min(currentIndex + 1, this.tierChain.length - 1)];
  }

  /**
   * Resolve a concrete model id for an escalation.
   * Honors an explicit config-driven model, then the injected resolver
   * (catalog-based by default). Returns null when no model is available,
   * in which case the loop enables reasoning settings on the current provider.
   */
  resolveModel(role, targetTier) {
    if (this.escalationModels[role]) return this.escalationModels[role];
    return typeof this.modelResolver === "function" ? this.modelResolver(targetTier) : null;
  }
}

module.exports = { recommendPolicy, EscalationEngine, DEFAULT_TIER_CHAIN, _MAX_TIMEOUT, _MAX_CYCLES };

"use strict";

/**
 * Verifier — reviews code changes for correctness and safety.
 */

const { capText, compactJson, summarizeChanges } = require("./prompt-utils");
const { decodeReview } = require("./compact-ir");

const COMPACT_REVIEW_SYSTEM_PROMPT = `You are a meticulous code reviewer. Return only compact JSON: {"v":"A|C|R","c":0.0,"f":[]}. No markdown or explanation.`;

const REVIEW_SYSTEM_PROMPT = `You are a meticulous code reviewer. Given the task, implementation changes, and diff, provide a thorough review.

Output format (strict JSON):
{
  "verdict": "APPROVE|CHANGES_REQUESTED|REJECT",
  "confidence": 0.0-1.0,
  "summary": "overall assessment",
  "findings": [
    {
      "severity": "info|warning|error|critical",
      "file": "path/to/file",
      "line": 123,
      "message": "description of issue"
    }
  ],
  "security_findings": [],
  "risk_level": "low|medium|high",
  "test_suggestions": ["what tests to add"]
}`;

async function verify(provider, task, changesResult, repoRoot, options = {}) {
  const diff = capText(require("../git/operations").diffStat(repoRoot), options.max_diff_chars || 8000);
  // .minitok/ contains run locks, contracts, evidence, and other internal
  // runtime state. It is intentionally not part of the user's code change and
  // must not be presented to the model as an unexpected modified file.
  const status = require("../git/operations").status(repoRoot, { excludeRuntime: true });

  const messages = [
    { role: "system", content: options.compact_output ? COMPACT_REVIEW_SYSTEM_PROMPT : REVIEW_SYSTEM_PROMPT },
    {
      role: "user",
      content: `## Task\n${task}\n\n## Change Summary\n${compactJson(summarizeChanges(changesResult))}\n\n## Current Diff\n${diff}\n\n## Git Status\n${capText(status || "clean", options.max_status_chars || 4000)}\n\n## Review Checklist\n- Correctness: does the code do what was asked?\n- Security: any injection, path traversal, secrets?\n- Performance: any obvious performance issues?\n- Style: consistent with existing code?\n- Errors: proper error handling?${options.context ? `\n\n## Stage Context\n${options.context}` : ""}`,
    },
  ];

  const result = await provider.complete(messages, {
    ...options,
    max_tokens: options.max_tokens || 4096,
    temperature: 0.1,
  });

  const { parseResponseJSON } = require("./json_utils");

  let review;
  const { parsed, valid } = parseResponseJSON(result.text, { error: "No JSON", raw: result.text });
  review = valid ? decodeReview(parsed) : { error: parsed.error || "Invalid JSON", raw: parsed.raw || result.text };
  // Keep the provider's stop reason: a review recorded as "Invalid JSON" because
  // the answer was truncated points the operator at the wrong problem.
  if (!valid && result.truncated) review = { error: `The model stopped at its output token limit (finish_reason: ${result.finish_reason}) before it produced valid JSON`, raw: review.raw, truncated: true };

  return { review, tokens: result.tokens, usage: result.usage, model: result.model, prompt_chars: messages.reduce((total, message) => total + String(message.content || "").length, 0) };
}

module.exports = { verify, REVIEW_SYSTEM_PROMPT };

"use strict";

/**
 * Verifier — reviews code changes for correctness and safety.
 */

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
  const diff = require("../git/operations").diffStat(repoRoot);
  const status = require("../git/operations").status(repoRoot);

  const messages = [
    { role: "system", content: REVIEW_SYSTEM_PROMPT },
    {
      role: "user",
      content: `## Task\n${task}\n\n## Implementation\n${JSON.stringify(changesResult, null, 2)}\n\n## Current Diff\n${diff}\n\n## Git Status\n${status || "clean"}\n\n## Review Checklist\n- Correctness: does the code do what was asked?\n- Security: any injection, path traversal, secrets?\n- Performance: any obvious performance issues?\n- Style: consistent with existing code?\n- Errors: proper error handling?`,
    },
  ];

  const result = await provider.complete(messages, {
    ...options,
    max_tokens: 4096,
    temperature: 0.1,
  });

  const { parseResponseJSON } = require("./json_utils");

  let review;
  const { parsed, valid } = parseResponseJSON(result.text, { error: "No JSON", raw: result.text });
  review = valid ? parsed : { error: parsed.error || "Invalid JSON", raw: parsed.raw || result.text };
  // Keep the provider's stop reason: a review recorded as "Invalid JSON" because
  // the answer was truncated points the operator at the wrong problem.
  if (!valid && result.truncated) review = { error: `The model stopped at its output token limit (finish_reason: ${result.finish_reason}) before it produced valid JSON`, raw: review.raw, truncated: true };

  return { review, tokens: result.tokens, model: result.model };
}

module.exports = { verify, REVIEW_SYSTEM_PROMPT };

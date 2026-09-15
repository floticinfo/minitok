"use strict";

/**
 * Planner — generates implementation plans from task descriptions.
 */

const { compactJson } = require("./prompt-utils");
const { decodePlan } = require("./compact-ir");

const COMPACT_PLAN_SYSTEM_PROMPT = `You are a senior software architect. Return only compact JSON: {"t":"summary","s":[{"i":1,"a":"modify","f":"file","d":"description","r":"reason"}],"n":1,"risk":"low|medium|high"}. No markdown.`;

const PLAN_SYSTEM_PROMPT = `You are a senior software architect. Given a task description and repository context, produce a detailed implementation plan.

Output format (strict JSON):
{
  "task_summary": "one-line summary",
  "steps": [
    {
      "id": 1,
      "action": "create|modify|delete",
      "file": "path/to/file",
      "description": "what to do",
      "rationale": "why this change"
    }
  ],
  "estimated_files": 5,
  "risk_level": "low|medium|high",
  "notes": "any caveats"
}`;

async function plan(provider, task, repoContext, options = {}) {
  const intelligence = options.intelligence ? `\n\n## Repository Intelligence\n${compactJson(options.intelligence)}` : "";
  const messages = [
    { role: "system", content: options.compact_output ? COMPACT_PLAN_SYSTEM_PROMPT : PLAN_SYSTEM_PROMPT },
    {
      role: "user",
      content: `## Task\n${task}\n\n## Repository Context\n${repoContext}${intelligence}\n\n## Constraints\n- Minimize file changes\n- Follow existing code patterns\n- Include error handling`,
    },
  ];

  const result = await provider.complete(messages, {
    ...options,
    max_tokens: options.max_tokens || 4096,
    temperature: 0.3,
  });

  const { parseResponseJSON } = require("./json_utils");

  let plan;
  const { parsed, valid } = parseResponseJSON(result.text, { error: "No JSON in response", raw: result.text });
  plan = valid ? decodePlan(parsed) : { error: parsed.error || "Invalid JSON", raw: parsed.raw || result.text };
  // A reply cut off by the output token limit is not a formatting mistake. Say so
  // instead of letting the run retry, escalate and pay for the same overflow.
  if (!valid && result.truncated) plan = { error: `The model stopped at its output token limit (finish_reason: ${result.finish_reason}) before it produced valid JSON`, raw: plan.raw, truncated: true };

  return { plan, tokens: result.tokens, model: result.model, usage: result.usage };
}

module.exports = { plan, PLAN_SYSTEM_PROMPT };

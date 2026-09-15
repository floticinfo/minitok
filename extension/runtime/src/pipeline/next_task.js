"use strict";

/**
 * NextTaskGenerator — generates the next task based on review feedback.
 *
 * Mirrors Python version's planner/next_task.py:
 * when a cycle completes, the review output feeds into generating
 * the next autonomous task until the goal is achieved.
 */

const GENERATE_NEXT_PROMPT = `You are an autonomous coding assistant. Given the original goal, completed work so far, and the latest review feedback, determine the NEXT task to work on.

If the goal is fully achieved, respond with exactly: {"done": true, "summary": "what was accomplished"}

Otherwise respond with:
{
  "done": false,
  "next_task": "specific next task description",
  "rationale": "why this task is needed next",
  "remaining_goals": ["list of goals not yet met"]
}`;

/**
 * Generate the next task based on previous cycle results.
 * @param {object} provider - LLM provider
 * @param {string} goal - original user goal
 * @param {Array} completedCycles - previous cycle results
 * @param {object} latestReview - latest review/verify result
 * @param {object} options
 * @returns {Promise<{ done: boolean, next_task?: string, summary?: string, remaining_goals?: string[], tokens?: { input: number, output: number } }>}
 */
async function generateNextTask(provider, goal, completedCycles, latestReview, options = {}) {
  const cycleSummaries = completedCycles.map((c, i) => {
    const planSummary = c.plan?.task_summary || c.plan?.steps?.map(s => s.description).join(", ") || "N/A";
    const status = c.status || "unknown";
    const filesChanged = c.implement?.files_changed || 0;
    return `Cycle ${i + 1}: ${status} (${filesChanged} files) - ${planSummary}`;
  }).join("\n");

  const reviewText = latestReview
    ? `Verdict: ${latestReview.verdict || "UNKNOWN"}\nConfidence: ${latestReview.confidence || "N/A"}\nSummary: ${latestReview.summary || "N/A"}\nFindings: ${(latestReview.findings || []).map(f => `[${f.severity}] ${f.message}`).join("; ")}`
    : "No review available";

  const messages = [
    { role: "system", content: GENERATE_NEXT_PROMPT },
    {
      role: "user",
      content: `## Original Goal\n${goal}\n\n## Completed Cycles\n${cycleSummaries || "None yet"}\n\n## Latest Review\n${reviewText}\n\n## Instructions\nAnalyze what's been done and what remains. If the goal is fully met, mark as done. Otherwise, specify the next concrete task.`,
    },
  ];

  const result = await provider.complete(messages, {
    ...options,
    max_tokens: options.max_tokens || 512,
    temperature: 0.3,
  });

  const { parseResponseJSON } = require("./json_utils");

  let parsed;
  const { parsed: jsonParsed, valid } = parseResponseJSON(result.text, { done: false, next_task: goal });
  parsed = valid ? jsonParsed : { done: false, next_task: goal };

  return {
    done: Boolean(parsed.done),
    next_task: parsed.next_task,
    summary: parsed.summary,
    remaining_goals: parsed.remaining_goals || [],
    tokens: result.tokens,
  };
}

module.exports = { generateNextTask, GENERATE_NEXT_PROMPT };

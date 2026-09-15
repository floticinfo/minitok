"use strict";

const { compactJson } = require("./prompt-utils");
const { decodeIntel } = require("./compact-ir");

const COMPACT_INTEL_SYSTEM_PROMPT = `You are a repository intelligence analyst. Return only compact JSON: {"s":"summary","f":["relevant file"],"p":["pattern"],"r":["risk"],"c":["constraint"],"n":["recommendation"]}. No markdown.`;

const INTEL_SYSTEM_PROMPT = `You are a repository intelligence analyst. Inspect the repository context and task, then identify the relevant files, existing implementations, constraints, risks, and missing information needed before planning.

Output strict JSON:
{
  "summary": "one-line repository assessment",
  "relevant_files": ["path"],
  "existing_patterns": ["pattern"],
  "risks": ["risk"],
  "constraints": ["constraint"],
  "recommendations": ["recommendation"]
}`;

async function intel(provider, task, repoContext, options = {}) {
  const messages = [
    { role: "system", content: options.compact_output ? COMPACT_INTEL_SYSTEM_PROMPT : INTEL_SYSTEM_PROMPT },
    { role: "user", content: `## Task\n${task}\n\n## Repository Context\n${repoContext}\n\nIdentify facts the planner must use. Do not propose changes outside the task.\n\n## Output Contract\n${compactJson({ format: "strict JSON", no_markdown: true })}` },
  ];
  const result = await provider.complete(messages, { ...options, max_tokens: options.max_tokens || 4096, temperature: 0.1 });
  const { parseResponseJSON } = require("./json_utils");
  const { parsed, valid } = parseResponseJSON(result.text, { error: "Invalid intelligence response", raw: result.text });
  return { intelligence: valid ? decodeIntel(parsed) : { error: parsed.error || "Invalid intelligence response", raw: parsed.raw || result.text }, tokens: result.tokens, usage: result.usage, model: result.model };
}

module.exports = { intel, INTEL_SYSTEM_PROMPT };

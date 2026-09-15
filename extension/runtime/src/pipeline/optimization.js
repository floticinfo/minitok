"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { capText, compactJson, shortHash } = require("./prompt-utils");
const { extractTaskPaths, classifyTask } = require("./task-routing");
const { isProtectedPath } = require("./implementer");

const DIRECT_SAFE_ACTIONS = /\b(?:change|update|set|fix|rename|replace|adjust|correct)\b/i;
const DIRECT_AMBIGUOUS = /\b(?:maybe|could|consider|architecture|refactor|rewrite|multiple|several|all|every|test|config|auth|security|dependency|package|build|deploy|release|workflow|ci)\b/i;

function directEditDecision(task, repoRoot, options = {}) {
  const classification = options.classification || classifyTask(task);
  const paths = extractTaskPaths(task);
  const maxBytes = Number(options.max_file_bytes) > 0 ? Number(options.max_file_bytes) : 1600;
  const result = { eligible: false, reason: "unknown", confidence: 0, profile: classification.profile, paths };
  if (options.enabled !== true) { result.reason = "disabled"; return result; }
  if (classification.profile !== "small_single_file" || paths.length !== 1) { result.reason = `profile_${classification.profile}`; return result; }
  if (!DIRECT_SAFE_ACTIONS.test(task) || DIRECT_AMBIGUOUS.test(task)) { result.reason = "ambiguous_language"; return result; }
  const relative = paths[0];
  const absolute = path.resolve(repoRoot, relative);
  const root = path.resolve(repoRoot);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) { result.reason = "path_outside_repository"; return result; }
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) { result.reason = "target_not_regular_file"; return result; }
    if (stat.size > maxBytes) { result.reason = "target_too_large"; return result; }
    if (isProtectedPath(repoRoot, absolute, { protectedExtraPaths: options.protected_paths || [] }).protected) { result.reason = "protected_path"; return result; }
  } catch { result.reason = "target_missing"; return result; }
  result.eligible = true;
  result.reason = "safe_explicit_single_file";
  result.confidence = 0.9;
  return result;
}

function projectStageContext(rawContext, stage, options = {}) {
  const raw = String(rawContext || "");
  const intelligence = options.intelligence;
  const plan = options.plan;
  if (stage === "intel") return { text: raw, original_chars: raw.length, reason: "intel_requires_repository_context" };
  if (stage === "plan") {
    const facts = intelligence ? compactJson({ summary: intelligence.summary, relevant_files: intelligence.relevant_files, constraints: intelligence.constraints, risks: intelligence.risks }) : "{}";
    const text = `Repository facts:\n${facts}\n\nRelevant context:\n${capText(raw, Math.min(raw.length, Number(options.max_chars) || 12000))}`;
    return { text, original_chars: raw.length, reason: "plan_uses_intelligence_projection" };
  }
  if (stage === "work") {
    const planText = plan ? compactJson({ task_summary: plan.task_summary, steps: plan.steps }) : "{}";
    const targetText = options.target_context || raw;
    const text = `Implementation targets:\n${planText}\n\nTarget context:\n${targetText}`;
    return { text, original_chars: raw.length, reason: "work_uses_plan_and_target_projection" };
  }
  const text = capText(raw, Number(options.max_chars) || 8000);
  return { text, original_chars: raw.length, reason: "stage_projection" };
}

function dynamicOutputBudget(stage, configured, options = {}) {
  const ceiling = Number(configured);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return undefined;
  if (options.enabled === false) return ceiling;
  const bytes = Math.max(0, Number(options.target_bytes) || 0);
  const operations = Math.max(1, Number(options.operations) || 1);
  const profile = options.profile || "uncertain";
  let suggested = ceiling;
  if (stage === "intel") suggested = profile === "small_single_file" ? 768 : 1024;
  else if (stage === "plan") suggested = profile === "small_single_file" ? 768 : Math.min(ceiling, 1536);
  else if (stage === "work") suggested = Math.max(512, Math.min(ceiling, 384 + operations * 96 + Math.ceil(bytes / 16)));
  else if (stage === "review") suggested = profile === "small_single_file" ? 768 : Math.min(ceiling, 1280);
  else if (stage === "repair") suggested = Math.max(512, Math.min(ceiling, 768 + operations * 256));
  return Math.max(256, Math.min(ceiling, suggested));
}

function repairContext(originalGoal, details = {}) {
  const payload = { goal: capText(originalGoal, 1200), files: details.files || [], failure: capText(details.failure || "", 2500), patch_digest: shortHash(details.patch || details.files || ""), required: "repair only the failed target" };
  return `repair.v1 ${JSON.stringify(payload)}`;
}

function providerCacheOptions(options = {}) {
  if (options.enabled === false) return { cache_input: false };
  const key = options.key || crypto.createHash("sha256").update(String(options.static_prefix || "minitok-static-policy-v1")).digest("hex").slice(0, 16);
  return { cache_input: true, cache_key: key, cache_policy: "static_prefix_v1" };
}

module.exports = { directEditDecision, projectStageContext, dynamicOutputBudget, repairContext, providerCacheOptions };

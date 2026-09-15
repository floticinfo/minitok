"use strict";

const PATH_PATTERN = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;
const NEW_FILE_PATTERN = /\b(?:create|add|new file|new module|scaffold|generate)\b/i;
const BROAD_PATTERN = /\b(?:refactor|rewrite|migrat(?:e|ion)|redesign|architecture|across|every|all modules|entire|whole repository|broad)\b/i;
const RISK_PATTERN = /\b(?:auth(?:entication|orization)?|security|credential|secret|permission|config(?:uration)?|build|dependency|package|test(?:s|ing)?|ci|workflow|deploy|release)\b/i;
const MULTI_PATTERN = /\b(?:files|modules|components|multiple|several|both|each|all)\b/i;
const SIMPLE_PATTERN = /\b(?:change|update|set|fix|rename|replace|adjust|correct)\b/i;

function extractTaskPaths(task) {
  return [...new Set((String(task || "").match(PATH_PATTERN) || []).map(value => value.replaceAll("\\", "/")))];
}

function classifyTask(task) {
  const text = String(task || "").trim();
  const paths = extractTaskPaths(text);
  if (!text) return { profile: "uncertain", paths, complexity: "unknown", reasons: ["empty_task"] };
  if (NEW_FILE_PATTERN.test(text)) return { profile: "new_file", paths, complexity: "medium", reasons: ["new_file_language"] };
  if (BROAD_PATTERN.test(text)) return { profile: "broad_rewrite", paths, complexity: "high", reasons: ["broad_or_structural_language"] };
  if (paths.length > 1 || MULTI_PATTERN.test(text)) return { profile: "multi_file", paths, complexity: "medium", reasons: [paths.length > 1 ? "multiple_explicit_paths" : "multi_file_language"] };
  if (paths.length === 1 && SIMPLE_PATTERN.test(text) && !RISK_PATTERN.test(text)) return { profile: "small_single_file", paths, complexity: "low", reasons: ["single_explicit_path", "simple_change_language"] };
  return { profile: "uncertain", paths, complexity: "unknown", reasons: [paths.length ? "path_without_safe_simple_language" : "no_explicit_path"] };
}

function shouldSkipIntel(task, options = {}) {
  const classification = options.classification || classifyTask(task);
  if (options.enabled !== true) return { skip: false, reason: "disabled", classification };
  if (options.strict_optimization === true) return { skip: false, reason: "strict_optimization", classification };
  if (options.force_research === true) return { skip: false, reason: "forced_research", classification };
  if (classification.profile !== "small_single_file") return { skip: false, reason: `profile_${classification.profile}`, classification };
  return { skip: true, reason: "safe_small_single_file", classification };
}

module.exports = { extractTaskPaths, classifyTask, shouldSkipIntel };

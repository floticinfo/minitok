"use strict";

const fs = require("node:fs");
const path = require("node:path");

const IGNORED_DIRECTORIES = new Set([".git", ".minitok", "node_modules", "dist", "build", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".hpp", ".swift", ".vue", ".svelte"]);
const STOP_WORDS = new Set(["change", "make", "update", "modify", "please", "should", "would", "could", "that", "this", "with", "from", "into", "preserve", "every", "other", "line", "file", "files", "code", "need", "want", "must", "repository", "implementation"]);

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function listSourceFiles(repoRoot, maxFiles = 500) {
  const files = [];
  const visit = directory => {
    if (files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(normalizePath(path.relative(repoRoot, absolute)));
        if (files.length >= maxFiles) return;
      }
    }
  };
  visit(repoRoot);
  return files;
}

function extractPaths(text) {
  const matches = String(text || "").match(/[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_./-]+/g) || [];
  return new Set(matches.map(normalizePath).filter(value => value.includes("/") && !value.startsWith("http")));
}

function extractKeywords(text, limit = 24) {
  const words = String(text || "").toLowerCase().match(/[a-z][a-z0-9_$-]{3,}/g) || [];
  return [...new Set(words.filter(word => !STOP_WORDS.has(word)))].slice(0, limit);
}

function extractLocalImports(content) {
  const imports = [];
  const source = String(content || "");
  const patterns = [
    /\bfrom\s*["'](\.[^"']+)["']/g,
    /\bimport\s*["'](\.[^"']+)["']/g,
    /\brequire\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) imports.push(normalizePath(match[1]));
  return [...new Set(imports)];
}

function lineRangesFor(content, keywords, maxFileChars) {
  const lines = String(content || "").split(/\r?\n/);
  if (content.length <= maxFileChars) return [{ start: 1, end: lines.length, text: content }];
  const ranges = [];
  const declaration = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)|^\s*(?:def|class)\s+([A-Za-z_][\w]*)/;
  const hasKeywordMatch = lines.some(line => keywords.some(keyword => line.toLowerCase().includes(keyword)));
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase();
    const isImport = /^\s*(?:import|export|require\(|from\s)/.test(lines[index]);
    const isDeclaration = declaration.test(lines[index]);
    const isKeywordMatch = keywords.some(keyword => lower.includes(keyword));
    if (isImport || isKeywordMatch || (!hasKeywordMatch && isDeclaration)) ranges.push({ priority: isKeywordMatch ? 2 : isImport ? 1 : 0, start: Math.max(1, index + 1 - 6), end: Math.min(lines.length, index + 1 + 18) });
  }
  if (!ranges.length) ranges.push({ priority: 0, start: 1, end: Math.min(lines.length, 40) });
  ranges.sort((a, b) => b.priority - a.priority || a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
      previous.priority = Math.max(previous.priority || 0, range.priority || 0);
    } else merged.push({ ...range });
  }
  const selected = [];
  let chars = 0;
  for (const range of merged) {
    let chunk = lines.slice(range.start - 1, range.end).join("\n");
    if (chunk.length > maxFileChars) {
      const matchingLines = lines.map((line, index) => ({ line, index })).filter(item => keywords.some(keyword => item.line.toLowerCase().includes(keyword)));
      const target = matchingLines.find(item => item.index + 1 >= range.start && item.index + 1 <= range.end)?.index ?? matchingLines[0]?.index ?? Math.floor((range.start + range.end) / 2) - 1;
      const start = Math.max(0, target - 3);
      const end = Math.min(lines.length, target + 4);
      chunk = lines.slice(start, end).join("\n");
      if (chunk.length > maxFileChars) chunk = chunk.slice(0, maxFileChars);
    }
    if (selected.length && chars + chunk.length > maxFileChars) break;
    selected.push({ ...range, text: chunk });
    chars += chunk.length;
  }
  return selected.length ? selected : [{ start: 1, end: Math.min(lines.length, 40), text: lines.slice(0, 40).join("\n").slice(0, maxFileChars) }];
}

function scoreFile(file, content, explicitPaths, keywords) {
  const normalized = normalizePath(file);
  const lower = normalized.toLowerCase();
  let score = explicitPaths.has(normalized) ? 1000 : 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) score += 25;
    score += Math.min(10, (content.toLowerCase().split(keyword).length - 1) * 2);
  }
  return score;
}

function buildFocusedContext(repoRoot, options = {}) {
  const baseContext = String(options.base_context || "");
  const maxFiles = Math.max(1, Number(options.max_files) || 12);
  const maxFileChars = Math.max(500, Number(options.max_file_chars) || 12000);
  const maxTotalChars = Math.max(maxFileChars, Number(options.max_total_chars) || 24000);
  const task = String(options.task || "");
  const planText = JSON.stringify(options.plan || {});
  const intelligenceText = JSON.stringify(options.intelligence || {});
  const requestText = `${task}\n${planText}\n${intelligenceText}`;
  const requestedPaths = [...extractPaths(requestText), ...(Array.isArray(options.protected_paths) ? options.protected_paths : [])];
  const keywords = extractKeywords(requestText);
  const availableFiles = listSourceFiles(repoRoot, Math.max(maxFiles * 20, 100));
  const fileContents = availableFiles.map(file => {
    try { return { file, content: fs.readFileSync(path.join(repoRoot, file), "utf8") }; } catch { return null; }
  }).filter(Boolean);
  const explicitPaths = new Set(fileContents.filter(item => requestedPaths.some(requested => item.file === requested || item.file.endsWith(`/${requested}`) || requested.endsWith(`/${item.file}`))).map(item => item.file));
  const dependencyPaths = new Set();
  for (const item of fileContents.filter(item => explicitPaths.has(item.file))) {
    for (const imported of extractLocalImports(item.content)) {
      const base = normalizePath(path.join(path.dirname(item.file), imported));
      for (const candidate of [base, `${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}/index.js`]) if (availableFiles.includes(candidate)) dependencyPaths.add(candidate);
    }
  }
  const relevantPaths = new Set([...explicitPaths, ...dependencyPaths]);
  const candidates = fileContents
    .filter(item => explicitPaths.size ? relevantPaths.has(item.file) : true)
    .map(item => ({ ...item, score: scoreFile(item.file, item.content, relevantPaths, keywords) }))
    .filter(item => explicitPaths.size ? relevantPaths.has(item.file) : item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, maxFiles);
  if (!candidates.length) return { text: baseContext, selected_files: [], selected_ranges: 0, fallback_reason: "no_relevant_source_files" };

  const metadataSections = (baseContext.match(/\n--- (?:package\.json|pyproject\.toml|README\.md|minitok\.yml|Cargo\.toml|go\.mod) ---[\s\S]*?(?=\n--- |$)/g) || []).map(section => section.slice(1));
  const header = baseContext.split(/\n--- /, 1)[0];
  const sections = [header, ...metadataSections, "## Focused source context"];
  let used = sections.join("\n").length;
  let selectedRanges = 0;
  const selectedFiles = [];
  for (const candidate of candidates) {
    const ranges = lineRangesFor(candidate.content, keywords, maxFileChars);
    const section = ranges.map(range => `--- ${candidate.file} lines ${range.start}-${range.end} ---\n${range.text}`).join("\n");
    if (used + section.length + 1 > maxTotalChars) continue;
    sections.push(section);
    used += section.length + 1;
    selectedFiles.push(candidate.file);
    selectedRanges += ranges.length;
  }
  if (!selectedFiles.length) return { text: baseContext, selected_files: [], selected_ranges: 0, fallback_reason: "focused_context_budget_exhausted" };
  return { text: sections.join("\n"), selected_files: selectedFiles, selected_ranges: selectedRanges, fallback_reason: null };
}

module.exports = { listSourceFiles, extractPaths, extractKeywords, lineRangesFor, buildFocusedContext };

#!/usr/bin/env node
/**
 * Reclaim `minitok-*` leftovers from the OS temp directory.
 *
 * Run manually with `npm run temp:sweep` (add `--dry-run` to preview) and
 * automatically before `npm test`, so fixtures leaked by an interrupted or
 * failing test run cannot accumulate forever.
 *
 * Always exits 0: housekeeping must never block a test run.
 */
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  sweepTempEntries,
  DEFAULT_PREFIXES,
  DEFAULT_RETENTION_MS,
  DEFAULT_PROTECT_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_SCAN,
  DEFAULT_TIME_BUDGET_MS,
} = require(path.join(root, "src", "utils", "temp-cleanup.js"));

const DURATION_UNITS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

function parseDuration(value, fallback) {
  if (value === undefined) return fallback;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) throw new Error(`invalid duration "${value}" (use 45s, 30m, 2h or 1d)`);
  const unit = DURATION_UNITS[(match[2] || "ms").toLowerCase()] || 1;
  return Math.round(Number(match[1]) * unit);
}

function parseArgs(argv) {
  const options = {
    retentionMs: DEFAULT_RETENTION_MS,
    protectMs: DEFAULT_PROTECT_MS,
    prefixes: [...DEFAULT_PREFIXES],
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxScan: DEFAULT_MAX_SCAN,
    timeBudgetMs: DEFAULT_TIME_BUDGET_MS,
    dryRun: false,
    json: false,
    quiet: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const inline = separator === -1 ? undefined : arg.slice(separator + 1);
    const value = () => (inline !== undefined ? inline : argv[++index]);
    if (flag === "--older-than") options.retentionMs = parseDuration(value(), DEFAULT_RETENTION_MS);
    else if (flag === "--protect") options.protectMs = parseDuration(value(), DEFAULT_PROTECT_MS);
    else if (flag === "--prefixes") options.prefixes = String(value() || "").split(",").map(item => item.trim()).filter(Boolean);
    else if (flag === "--max-entries") options.maxEntries = Number(value());
    else if (flag === "--max-scan") options.maxScan = Number(value());
    else if (flag === "--time-budget") options.timeBudgetMs = parseDuration(value(), DEFAULT_TIME_BUDGET_MS);
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--quiet") options.quiet = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`unknown option "${arg}"`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`sweep-temp: ${error.message}`);
    return 0;
  }
  if (options.help) {
    console.log("Usage: node scripts/sweep-temp.mjs [--older-than 2h] [--protect 10m] [--prefixes minitok-,mtok-] [--max-entries 200] [--max-scan 20000] [--time-budget 250ms|0] [--dry-run] [--json] [--quiet]");
    return 0;
  }
  const tmpdir = os.tmpdir();
  const summary = sweepTempEntries({
    tmpdir,
    prefixes: options.prefixes,
    retentionMs: options.retentionMs,
    protectMs: options.protectMs,
    maxEntries: options.maxEntries,
    maxScan: options.maxScan,
    timeBudgetMs: options.timeBudgetMs,
    dryRun: options.dryRun,
  });
  if (options.json) {
    console.log(JSON.stringify({ tmpdir, retentionMs: options.retentionMs, protectMs: options.protectMs, ...summary }));
    return 0;
  }
  if (!options.quiet || summary.removed > 0 || options.dryRun) {
    const verb = options.dryRun ? "would reclaim" : "reclaimed";
    const count = options.dryRun ? summary.candidates : summary.removed;
    console.log(`sweep-temp: ${verb} ${count}/${summary.candidates} entries untouched for over ${options.retentionMs}ms under ${tmpdir}`);
    if (!summary.drained) console.log("sweep-temp: backlog remains; run again to continue");
    if (summary.errors) console.log(`sweep-temp: ${summary.errors} entr${summary.errors === 1 ? "y" : "ies"} could not be reclaimed`);
  }
  return 0;
}

process.exitCode = main();

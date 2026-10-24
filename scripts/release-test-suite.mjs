#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const groups = ["unit", "security", "workspace", "mcp", "goal", "extension"];
const timeoutMs = 360000;
const WINDOWS_GRACE_MS = 1000;
const WINDOWS_CRASH_EXIT = 3221225794;

function runGroup(group) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["scripts/test-suite.mjs", `--group=${group}`, "--timeout-ms=360000", "--test-timeout-ms=120000"], {
      cwd: root,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    const timer = setTimeout(() => {
      console.error(`Release test group '${group}' exceeded ${timeoutMs}ms.`);
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
      resolve(124);
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); console.error(`Release test group '${group}' failed to start: ${error.message}`); resolve(1); });
    child.once("exit", (code, signal) => { clearTimeout(timer); const result = signal ? 1 : code ?? 1; if (result === WINDOWS_CRASH_EXIT) console.error(`Release test group '${group}' hit Windows process crash exit ${WINDOWS_CRASH_EXIT}; inspect stale child processes and file handles before retrying.`); resolve(result); });
  });
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const releaseTempRoot = mkdtempSync(path.join(os.tmpdir(), "minitok-release-test-"));
process.env.TEMP = releaseTempRoot;
process.env.TMP = releaseTempRoot;
process.env.TMPDIR = releaseTempRoot;
try {
for (const group of groups) {
  const code = await runGroup(group);
  if (code !== 0) {
    console.error(`Release test suite stopped at group '${group}' with exit ${code}.`);
    process.exitCode = code;
    break;
  }
  if (process.platform === "win32") await delay(WINDOWS_GRACE_MS);
}
if (process.exitCode === undefined) {
  console.log(`Release test suite passed: ${groups.join(", ")}`);
  process.exitCode = 0;
}
} finally {
  try { rmSync(releaseTempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (error) { console.error(`Release test temp cleanup warning: ${error.message}`); }
}

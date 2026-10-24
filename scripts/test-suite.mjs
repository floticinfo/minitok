import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_TIMEOUT_MS = 300000;
export const DEFAULT_TEST_TIMEOUT_MS = 120000;
const LIVE = new Set(["test-camelstream-live.js", "test-ci-live-evidence.js", "test-cli-longrun.js", "test-live-provider-workflow.js", "test-live-readiness.js", "test-npm-installer-live.js", "test-provider-live.js", "test-provider-longrun.js"]);
const RELEASE = new Set(["test-adapter-registry.js", "test-mcp-registry-metadata.js", "test-registry-compat.js", "test-release-artifacts.js"]);
const OVERRIDES = Object.freeze({ "tests/e2e/real-swe/test-real-swe-fixture.js": "e2e", "tests/e2e/goal-agent/harness.test.js": "e2e", "tests/fixtures/local-http-app/server.test.js": "e2e" });
const rel = file => path.relative(root, file).replaceAll(path.sep, "/");

export function classify(file) {
  if (OVERRIDES[file]) return OVERRIDES[file];
  const name = path.basename(file).toLowerCase();
  if (LIVE.has(path.basename(file))) return "live";
  if (RELEASE.has(path.basename(file))) return "release";
  if (name.includes("e2e") || name.includes("benchmark")) return "e2e";
  if (name.includes("extension")) return "extension";
  if (name.includes("mcp")) return "mcp";
  if (name.includes("goal") || name.includes("autonom") || name.includes("phase") || name.includes("recovery")) return "goal";
  if (name.includes("security") || name.includes("capabil") || name.includes("auth") || name.includes("path-name") || name.includes("write-policy")) return "security";
  if (name.includes("workspace") || name.includes("isolation") || name.includes("diff-restore")) return "workspace";
  return "unit";
}
export function isTestFile(file) {
  if (file.startsWith("node_modules/") || file.startsWith(".git/") || file.includes("/dist/") || file.includes("/Temp/")) return false;
  return (file.startsWith("tests/") && (/(^|\/)test-.*\.js$/.test(file) || file.endsWith(".test.js"))) || (file.startsWith("src/") && file.endsWith(".test.js")) || (file.startsWith("scripts/") && file.endsWith(".test.mjs"));
}
export async function collect(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "Temp"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute, files);
    else if (entry.isFile() && isTestFile(rel(absolute))) files.push(rel(absolute));
  }
  return files;
}
export async function discoverTests() {
  const files = [];
  for (const directory of ["tests", "src", "scripts"]) { try { await collect(path.join(root, directory), files); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  return files.sort();
}
function options(argv) {
  const get = key => argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
  const timeoutMs = Number(get("--timeout-ms") || DEFAULT_TIMEOUT_MS);
  const testTimeoutMs = Number(get("--test-timeout-ms") || DEFAULT_TEST_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(testTimeoutMs) || testTimeoutMs <= 0) throw new Error("timeouts must be positive integers");
  return { group: get("--group") || "default", timeoutMs, testTimeoutMs, list: argv.includes("--list"), passthrough: argv.filter(value => !value.startsWith("--group=") && !value.startsWith("--timeout-ms=") && !value.startsWith("--test-timeout-ms=") && value !== "--list") };
}
export async function run(argv = process.argv.slice(2)) {
  const opts = options(argv); const all = await discoverTests();
  const files = opts.group === "all" ? all : opts.group === "default" ? all.filter(file => !["live", "release", "e2e"].includes(classify(file))) : all.filter(file => classify(file) === opts.group);
  if (!files.length) throw new Error(`No tests selected for group '${opts.group}'.`);
  if (opts.list) { files.forEach(file => console.log(`${classify(file)}\t${file}`)); return 0; }
  const started = performance.now(); console.log(`Test group '${opts.group}': ${files.length} files; per-file timeout ${opts.testTimeoutMs}ms`);
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", `--test-timeout=${opts.testTimeoutMs}`, ...opts.passthrough, ...files], { cwd: root, stdio: "inherit", shell: false, detached: process.platform !== "win32", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; console.error(`Test group '${opts.group}' exceeded ${opts.timeoutMs}ms; terminating child process tree.`); if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } } }, opts.timeoutMs);
  return await new Promise(resolve => { child.once("error", error => { clearTimeout(timer); console.error(`Test runner failed to start: ${error.message}`); resolve(1); }); child.once("exit", (code, signal) => { clearTimeout(timer); const result = timedOut ? 124 : signal ? 1 : code ?? 1; console.log(`Test group '${opts.group}' finished in ${Math.round(performance.now() - started)}ms (exit ${result})`); resolve(result); }); });
}
const isMain = path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try { process.exitCode = await run(); } catch (error) { console.error(`Test runner configuration failed: ${error.message}`); process.exitCode = 1; }
}

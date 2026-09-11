"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function getVerifyCommandPath(repoRoot, configuredPath) {
  const relativePath = configuredPath || "VERIFY_CMD.sh";
  const scriptPath = path.resolve(repoRoot, relativePath);
  const root = fs.realpathSync(repoRoot);
  if (!(scriptPath === path.resolve(repoRoot) || scriptPath.startsWith(path.resolve(repoRoot) + path.sep))) throw new Error("VERIFY_CMD.sh path must stay inside the repository");
  if (fs.existsSync(scriptPath)) {
    const stat = fs.lstatSync(scriptPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Verification script must be a regular file");
    const canonical = fs.realpathSync(scriptPath);
    if (!(canonical === root || canonical.startsWith(root + path.sep))) throw new Error("Verification script must stay inside the repository");
  }
  return scriptPath;
}

function bashRuntime() {
  try {
    const result = execFileSync("bash", ["-c", "printf '%s|%s' \"$MSYSTEM\" \"$(uname -s)\""], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    const [msystem, uname] = result.split("|");
    // Git Bash exposes MSYSTEM=MINGW*/MSYS* and understands /c/... paths.
    if (/^(MINGW|MSYS)/i.test(msystem || "")) return { available: true, kind: "git-bash", msystem, uname };
    // WSL's bash.exe is not compatible with Git Bash's /c/... conversion;
    // use the portable Node gate instead.
    if (/Linux/i.test(uname || "")) return { available: true, kind: "wsl", msystem, uname };
    return { available: false, kind: "unknown", msystem, uname };
  } catch {
    return { available: false, kind: "missing" };
  }
}

function bashAvailable() {
  return bashRuntime().kind === "git-bash";
}

function runVerification(repoRoot, options = {}) {
  const configuredPath = options.script_path || "VERIFY_CMD.sh";
  const scriptPath = getVerifyCommandPath(repoRoot, configuredPath);
  const isNodeGate = configuredPath.endsWith(".mjs");
  if (isNodeGate) {
    // The customer's own gate verifies THE CUSTOMER'S PROJECT. Only a
    // repo-local VERIFY_CMD.mjs (created by `minitok migrate`) may run here —
    // never the bundled scripts/verify.mjs, which would test minitok itself
    // and turn the deterministic gate into a vacuous green check.
    if (!fs.existsSync(scriptPath)) {
      return {
        status: "missing",
        command: scriptPath,
        output: `Verification script was not found: ${scriptPath}. Run 'minitok migrate' to create one, or set validation.script_path in minitok.yml.`,
        duration_ms: 0,
        exit_code: 1,
      };
    }
    const bundledRoot = path.resolve(__dirname, "../../scripts");
    const canonicalScript = fs.realpathSync(scriptPath);
    if (canonicalScript === path.join(bundledRoot, "verify.mjs") || canonicalScript === path.join(bundledRoot, "release-verify.mjs")) {
      return { status: "failed", command: scriptPath, output: "Bundled minitok verification scripts cannot be used as the customer gate. Set validation.script_path to a repo-local VERIFY_CMD.mjs.", duration_ms: 0, exit_code: 1 };
    }
    return runProcess(process.execPath, [scriptPath], repoRoot, options);
  }
  if (!fs.existsSync(scriptPath)) {
    return { status: "missing", command: scriptPath, output: "Verification script was not found", duration_ms: 0, exit_code: 1 };
  }
  // Windows fallback: a POSIX gate needs a bash runtime. When none is on PATH
  // but the npm-based VERIFY_CMD.mjs is available, degrade to it instead of
  // failing the whole pipeline with a bare "bash: command not found".
  if (process.platform === "win32" && !(options.command && options.command !== "bash") && !bashAvailable()) {
    const mjsPath = path.join(repoRoot, "VERIFY_CMD.mjs");
    if (fs.existsSync(mjsPath)) {
      const fallback = runVerification(repoRoot, { ...options, script_path: "VERIFY_CMD.mjs" });
      return { ...fallback, output: `[Windows fallback: VERIFY_CMD.sh requires Git Bash; used VERIFY_CMD.mjs instead]\n${fallback.output}`.slice(-4000) };
    }
    return {
      status: "failed",
      command: "bash",
      output: "VERIFY_CMD.sh requires a bash runtime on Windows. Install Git Bash (and add it to PATH) or switch the gate to VERIFY_CMD.mjs in minitok.yml (validation.script_path).",
      duration_ms: 0,
      exit_code: 1,
    };
  }
  const command = options.command || "bash";
  const executablePath = process.platform === "win32" && path.isAbsolute(scriptPath)
    ? `/${scriptPath[0].toLowerCase()}${scriptPath.slice(2).replace(/\\/g, "/")}`
    : scriptPath;
  const args = options.args || [executablePath];
  return runProcess(command, args, repoRoot, options);
}

function verificationEnvironment(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^MINITOK_(OFFLINE|DEFAULT_PROVIDER|SERVER_URL|PROJECT_|BUDGET_|EXECUTION_|VALIDATION_)/i.test(key)) delete env[key];
  }
  return env;
}

function runProcess(command, args, repoRoot, options = {}) {
  const started = Date.now();
  try {
    const output = execFileSync(command, args, { cwd: repoRoot, env: options.env || verificationEnvironment(), encoding: "utf-8", timeout: options.timeout_ms || 120000, stdio: ["ignore", "pipe", "pipe"] });
    return { status: "passed", command: [command, ...args].join(" "), output: output.slice(-4000), duration_ms: Date.now() - started, exit_code: 0 };
  } catch (error) {
    return { status: "failed", command: [command, ...args].join(" "), output: `${error.stdout || ""}${error.stderr || ""}`.slice(-4000), duration_ms: Date.now() - started, exit_code: typeof error.status === "number" ? error.status : 1 };
  }
}

function syncCanonicalRuntime(repoRoot) {
  try {
    const packagePath = path.join(repoRoot, "package.json");
    if (!fs.existsSync(packagePath)) return null;
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    if (packageJson.name !== "@flotic/minitok") return null;
    const script = path.join(repoRoot, "scripts", "sync-extension-runtime.mjs");
    if (!fs.existsSync(script)) return null;
    return runProcess(process.execPath, [script], repoRoot, { timeout_ms: 120000, env: verificationEnvironment() });
  } catch (error) {
    return { status: "failed", command: "sync-extension-runtime", output: error.message, exit_code: 1, duration_ms: 0 };
  }
}

function verifyCommand(repoRoot, options = {}) {
  const sync = syncCanonicalRuntime(repoRoot);
  if (sync && sync.status !== "passed") return { passed: false, evidence: sync };
  const evidence = runVerification(repoRoot, options);
  return { passed: evidence.status === "passed" && evidence.exit_code === 0, evidence };
}

module.exports = { runVerification, verifyCommand, bashAvailable, bashRuntime, verificationEnvironment, syncCanonicalRuntime };

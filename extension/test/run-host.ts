import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { download, runTests } from "@vscode/test-electron";

const HOST_TEST_TIMEOUT_MS = Number.isFinite(Number(process.env.MINITOK_HOST_TEST_TIMEOUT_MS))
  ? Math.max(1000, Number(process.env.MINITOK_HOST_TEST_TIMEOUT_MS))
  : 25000;
const DOWNLOAD_TIMEOUT_MS = Number.isFinite(Number(process.env.MINITOK_HOST_DOWNLOAD_TIMEOUT_MS))
  ? Math.max(1000, Number(process.env.MINITOK_HOST_DOWNLOAD_TIMEOUT_MS))
  : 10000;

function terminateProcessTree() {
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(process.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 5000 }); } catch {}
  } else {
    try { process.kill(process.pid, "SIGTERM"); } catch {}
  }
}

const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
const extensionTestsPath = path.resolve(__dirname, "extension-host.js");
let phase = "startup";

function assertExecutableIsVSCode(executable: string) {
  if (!existsSync(executable)) return;
  const normalizedExecutable = executable.replaceAll("\\\\", "/");
  const basename = path.basename(executable).toLowerCase();
  if (process.platform === "win32" && (basename === "code.exe" || basename === "code-insiders.exe")) {
    const installRoot = path.dirname(executable);
    const versionedRoots = [installRoot, ...readdirSync(installRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(installRoot, entry.name))];
    const productPath = versionedRoots
      .map(root => path.join(root, "resources", "app", "product.json"))
      .find(candidate => existsSync(candidate));
    if (productPath) {
      try {
        const product = JSON.parse(readFileSync(productPath, "utf8"));
        if (product?.applicationName === "code" || product?.applicationName === "code-insiders" || product?.win32AppUserModelId?.startsWith("Microsoft.VisualStudioCode")) return;
      } catch {}
    }
  }
  try {
    const version = execFileSync(executable, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
    if (/^v\d+\.\d+\.\d+$/i.test(version)) {
      throw new Error(`VS Code test executable is actually Node (${version}): ${normalizedExecutable}. Set MINITOK_VSCODE_EXECUTABLE to a real VS Code binary or unset it so @vscode/test-electron can download one.`);
    }
  } catch (error) {
    if (error instanceof Error && /actually Node/.test(error.message)) throw error;
    // A real VS Code binary may not expose a useful version through this probe;
    // let @vscode/test-electron produce its normal launch error in that case.
  }
}

async function main() {
  if (process.env.MINITOK_HOST_TEST_SKIP_DOWNLOAD === "1" && !process.env.MINITOK_VSCODE_EXECUTABLE) {
    console.error("host test skipped: set MINITOK_VSCODE_EXECUTABLE to a real VS Code binary or unset MINITOK_HOST_TEST_SKIP_DOWNLOAD");
    process.exitCode = 2;
    return;
  }
  const timeout = setTimeout(() => {
    console.error(`host test timed out after ${HOST_TEST_TIMEOUT_MS}ms; phase=${phase}`);
    terminateProcessTree();
    process.exit(2);
  }, HOST_TEST_TIMEOUT_MS);
  try {
    const configuredExecutable = process.env.MINITOK_VSCODE_EXECUTABLE?.trim();
    phase = configuredExecutable ? "validate-configured-executable" : "download-vscode";
    console.error(`[host] ${phase}`);
    const executable = configuredExecutable || await download({ version: "stable", platform: process.platform === "win32" ? "win32-x64-archive" : undefined, cachePath: path.join(extensionDevelopmentPath, ".vscode-test"), timeout: DOWNLOAD_TIMEOUT_MS });
    assertExecutableIsVSCode(executable);
    phase = "launch-extension-host";
    console.error(`[host] ${phase}`);
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ["--disable-extensions"],
      extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined, VSCODE_PID: undefined },
    });
    console.error("[host] pass");
  } finally {
    clearTimeout(timeout);
  }
}

main().catch(error => {
  console.error(`host test failed during ${phase}:`, error);
  process.exitCode = 1;
});

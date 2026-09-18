import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env.npm_execpath;
const npmCommand = process.platform === "win32" ? process.execPath : (npmExecPath || "npm");
const npmArgs = args => process.platform === "win32"
  ? [npmExecPath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args]
  : args;
const npmNetworkFlags = ["--no-audit", "--no-fund", "--prefer-offline", "--fetch-retries=0", "--fetch-timeout=10000"];
const runNpm = (stage, args) => {
  const started = Date.now();
  process.stderr.write(`[packed-install] ${stage}: start\n`);
  try {
    const output = execFileSync(npmCommand, npmArgs(args), {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, CI: "1", npm_config_audit: "false", npm_config_fund: "false" },
      timeout: 120000,
    });
    process.stderr.write(`[packed-install] ${stage}: passed in ${Date.now() - started}ms\n`);
    return output;
  } catch (error) {
    process.stderr.write(`[packed-install] ${stage}: failed after ${Date.now() - started}ms\n`);
    process.stderr.write(`${error.stdout || ""}${error.stderr || ""}`);
    throw error;
  }
};
const runCli = (cli, consumer, args) => {
  const started = Date.now();
  const stage = `cli ${args.join(" ")}`;
  process.stderr.write(`[packed-install] ${stage}: start\n`);
  try {
    const output = execFileSync(process.execPath, [cli, ...args], { cwd: consumer, encoding: "utf8", stdio: "pipe", env: { ...process.env, CI: "1", MINITOK_UPDATE_CHECK: "0" }, timeout: 30000 });
    process.stderr.write(`[packed-install] ${stage}: passed in ${Date.now() - started}ms\n`);
    return output;
  } catch (error) {
    process.stderr.write(`[packed-install] ${stage}: failed after ${Date.now() - started}ms\n`);
    process.stderr.write(`${error.stdout || ""}${error.stderr || ""}`);
    throw error;
  }
};
const prefix = mkdtempSync(path.join(os.tmpdir(), "minitok-packed-"));
try {
  const packOutput = runNpm("npm pack", ["pack", "--pack-destination", prefix, "--json", ...npmNetworkFlags]);
  const packResult = JSON.parse(packOutput)[0];
  const packedFiles = new Set((packResult.files || []).map(file => file.path));
  const requiredFiles = ["package.json", "bin/minitok.js", "src/index.js", "src/promotion/demo.js", "src/promotion/manifest.js", "scripts/promotion-demo.mjs"];
  const forbiddenFiles = ["VERIFY_CMD.mjs", "VERIFY_CMD.sh", "scripts/verify.mjs", "scripts/release-verify.mjs", "scripts/secret-scan.mjs", "scripts/documentation-consistency.mjs", "scripts/packed-install-smoke.mjs", "extension/package.json"];
  for (const file of requiredFiles) if (!packedFiles.has(file)) throw new Error(`final package omits runtime file: ${file}`);
  for (const file of forbiddenFiles) if (packedFiles.has(file)) throw new Error(`final package includes development-only file: ${file}`);
  const archiveName = readdirSync(prefix).find(name => name.endsWith(".tgz"));
  if (!archiveName) throw new Error("npm pack did not produce a tarball");
  const archive = path.join(prefix, archiveName);
  const consumer = path.join(prefix, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "packed-consumer", private: true }));
  runNpm("npm install", ["install", "--prefix", consumer, "--ignore-scripts", ...npmNetworkFlags, archive]);
  const packageRoot = path.join(consumer, "node_modules", "@flotic", "minitok");
  const cli = path.join(packageRoot, "bin", "minitok.js");
  if (!existsSync(cli)) throw new Error(`packed install did not resolve the package bin: ${cli}`);
  for (const args of [["--help"], ["status"], ["auth", "status"]]) runCli(cli, consumer, args);
  const cliDemo = path.join(consumer, "cli-demo");
  const cliDemoOutput = runCli(cli, consumer, ["promote", "demo", "--directory", cliDemo]);
  if (!/Demo fixture created:/.test(cliDemoOutput) || !existsSync(path.join(cliDemo, "minitok-demo-plan.json"))) throw new Error("packed CLI promote demo did not create a fixture");
  const scriptDemo = path.join(consumer, "script-demo");
  runNpm("packed promotion script", ["run", "--prefix", packageRoot, "promotion:demo", "--", "--directory", scriptDemo]);
  if (!existsSync(path.join(scriptDemo, "minitok-demo-plan.json"))) throw new Error("packed promotion:demo script did not create a fixture");
} finally {
  rmSync(prefix, { recursive: true, force: true });
}

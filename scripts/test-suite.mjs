import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function collect(directory, predicate, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute, predicate, files);
    else if (entry.isFile() && predicate(entry.name, absolute)) files.push(path.relative(root, absolute));
  }
  return files;
}

const testFiles = [
  ...(await collect(path.join(root, "tests"), name => name.endsWith(".js"))),
  ...(await collect(path.join(root, "src"), name => name.endsWith(".test.js"))),
].sort();

if (testFiles.length === 0) {
  console.error("No test files were discovered.");
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
});

child.once("error", error => {
  console.error(`Test runner failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Test runner terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});

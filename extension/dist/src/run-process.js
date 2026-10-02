"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.killProcessTree = killProcessTree;
exports.runProcess = runProcess;
const node_child_process_1 = require("node:child_process");
const workspace_1 = require("./workspace");
/**
 * Kill a child process and everything it spawned.
 * Windows needs taskkill /t; POSIX children started detached form a process
 * group that can be signalled with a negative pid.
 */
function killProcessTree(child) {
    if (child.killed)
        return;
    if (process.platform === "win32") {
        (0, node_child_process_1.execFile)("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 10000 }, error => { if (error)
            child.kill(); });
    }
    else {
        try {
            process.kill(-child.pid, "SIGTERM");
        }
        catch {
            child.kill("SIGTERM");
        }
    }
}
/**
 * Run a command (via spawnSpec/spawnOptionsFor), collect bounded stdout/stderr,
 * and settle on close, spawn error, timeout, or cancellation.
 */
function runProcess(command, args, options = {}) {
    const { cwd, env, timeoutMs, token, detached, onProcess, onStdout, onStderr } = options;
    const timeoutMessage = options.timeoutMessage ?? "minitok timed out";
    const cancelledMessage = options.cancelledMessage ?? "minitok run cancelled";
    return new Promise((resolve, reject) => {
        const spec = (0, workspace_1.spawnSpec)(command, args);
        let child;
        try {
            child = (0, node_child_process_1.spawn)(spec.command, spec.args, options.spawnOptions ?? (0, workspace_1.spawnOptionsFor)(spec, { cwd, env, detached }));
        }
        catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        onProcess?.(child);
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer;
        let cancellation;
        const finish = (error, value = "") => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (cancellation)
                cancellation.dispose();
            onProcess?.(undefined);
            if (error)
                reject(error);
            else
                resolve(value);
        };
        if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
                killProcessTree(child);
                // Settle from the timeout as well. If the kill cannot be delivered (a
                // detached tree on Windows, an unkillable handle) no close event ever
                // fires and the caller would stay "run active" forever.
                finish(new Error(timeoutMessage));
            }, timeoutMs);
        }
        cancellation = token?.onCancellationRequested(() => { killProcessTree(child); finish(new Error(cancelledMessage)); });
        child.stdout.on("data", chunk => { stdout = (0, workspace_1.appendBoundedOutput)(stdout, chunk.toString()); onStdout?.(chunk); });
        child.stderr.on("data", chunk => { stderr = (0, workspace_1.appendBoundedOutput)(stderr, chunk.toString()); onStderr?.(chunk); });
        child.on("error", error => finish(error));
        child.on("close", code => code === 0 ? finish(null, stdout) : finish(new Error(stderr || stdout || `minitok exited with code ${code}`)));
    });
}

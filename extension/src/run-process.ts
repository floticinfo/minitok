import { spawn, execFile, ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnSpec, spawnOptionsFor, appendBoundedOutput } from "./workspace";

/**
 * Minimal cancellation surface, structurally compatible with
 * vscode.CancellationToken, so this module stays free of the vscode import.
 */
export interface CancellationTokenLike {
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  token?: CancellationTokenLike;
  /** Run the child in its own process group so the whole tree can be signalled. */
  detached?: boolean;
  /** Called with the child once spawned and with undefined when the run settles. */
  onProcess?: (child: ChildProcessWithoutNullStreams | undefined) => void;
  /** Called with every stdout/stderr chunk (progress/log streaming). */
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  /** Error text for the timeout rejection. */
  timeoutMessage?: string;
  /** Error text for the cancellation rejection. */
  cancelledMessage?: string;
  /**
   * Prebuilt spawn options. Call sites that already hold a SpawnSpec can build
   * their options with spawnOptionsFor and pass them through instead of having
   * them recomputed here.
   */
  spawnOptions?: object;
}

/**
 * Kill a child process and everything it spawned.
 * Windows needs taskkill /t; POSIX children started detached form a process
 * group that can be signalled with a negative pid.
 */
export function killProcessTree(child: ChildProcessWithoutNullStreams) {
  if (child.killed) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 10000 }, error => { if (error) child.kill(); });
  } else {
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

/**
 * Run a command (via spawnSpec/spawnOptionsFor), collect bounded stdout/stderr,
 * and settle on close, spawn error, timeout, or cancellation.
 */
export function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<string> {
  const { cwd, env, timeoutMs, token, detached, onProcess, onStdout, onStderr } = options;
  const timeoutMessage = options.timeoutMessage ?? "minitok timed out";
  const cancelledMessage = options.cancelledMessage ?? "minitok run cancelled";
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(command, args);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(spec.command, spec.args, options.spawnOptions ?? spawnOptionsFor(spec, { cwd, env, detached })); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
    onProcess?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let cancellation: { dispose(): void } | undefined;
    const finish = (error: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (cancellation) cancellation.dispose();
      onProcess?.(undefined);
      if (error) reject(error); else resolve(value);
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
    child.stdout.on("data", chunk => { stdout = appendBoundedOutput(stdout, chunk.toString()); onStdout?.(chunk); });
    child.stderr.on("data", chunk => { stderr = appendBoundedOutput(stderr, chunk.toString()); onStderr?.(chunk); });
    child.on("error", error => finish(error));
    child.on("close", code => code === 0 ? finish(null, stdout) : finish(new Error(stderr || stdout || `minitok exited with code ${code}`)));
  });
}

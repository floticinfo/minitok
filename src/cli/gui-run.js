"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setTimeout: wait } = require("timers/promises");
const { runPipeline } = require("../pipeline/loop");

/**
 * Write the approval response the pipeline expects.
 *
 * The contract is bound to the request: `validateApprovalResponse` in
 * pipeline/loop.js only accepts a payload that repeats the request nonce and run
 * id and carries nothing else. The GUI wrote `{ decision }` alone, so every
 * answer was discarded as invalid and the run waited out the full approval
 * timeout (30 minutes by default) before failing closed.
 */
function writeApprovalResponse(approvalFile, decision) {
  let request;
  try { request = JSON.parse(fs.readFileSync(approvalFile, "utf8")); } catch { return { ok: false, reason: "Approval request is unreadable; the run will time out closed." }; }
  if (!request || request.type !== "approval_request" || typeof request.nonce !== "string") return { ok: false, reason: "Approval request is malformed; the run will time out closed." };
  const target = `${approvalFile}.response`;
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ decision, nonce: request.nonce, run_id: typeof request.run_id === "string" ? request.run_id : null })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
    return { ok: true };
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    return { ok: false, reason: `Approval response could not be written: ${error.message}` };
  }
}

async function runTask(task, repo, rl, state) {
  if (state.activeAbort) throw new Error("A run is already active");
  state.approvalActive = false;
  const approvalFile = path.join(os.tmpdir(), `minitok-cli-approval-${Date.now()}.json`);
  const abort = new AbortController(); state.activeAbort = abort;
  const onSigint = () => { abort.abort(); console.log("\nInterrupting..."); };
  process.once("SIGINT", onSigint);
  const stateFile = path.join(repo, ".minitok", "cli-gui-state.json"); const historyFile = path.join(repo, ".minitok", "cli-gui-history.jsonl"); const contextFile = path.join(repo, ".minitok", "cli-gui-context.json"); fs.mkdirSync(path.dirname(stateFile), { recursive: true }); const record = event => { try { fs.appendFileSync(historyFile, `${JSON.stringify({ timestamp: new Date().toISOString(), task, ...event })}\n`); const lines = fs.readFileSync(historyFile, "utf8").trim().split(/\r?\n/); if (lines.length > 500) fs.writeFileSync(historyFile, `${lines.slice(-500).join("\n")}\n`); } catch {} };
  // The approval watcher polls the request path until the run asks for approval
  // or finishes. Without the completion flag, a run that never requested approval
  // left this loop polling a deleted path every 150 ms for the life of the
  // process (one leaked timer per task).
  let approvalWatcherDone = false;
  void (async () => { while (!approvalWatcherDone && !abort.signal.aborted && !fs.existsSync(approvalFile)) await wait(150); if (approvalWatcherDone || !fs.existsSync(approvalFile)) return; state.approvalActive = true; record({ type: "approval", status: "pending" }); rl.pause(); console.log("\nReview changes: Approve? [y/n]"); const answer = await new Promise(resolve => { const ask = () => rl.question("approval> ", value => { const v = value.trim().toLowerCase(); if (["y", "yes", "n", "no"].includes(v)) resolve(v.startsWith("y") ? "approve" : "reject"); else ask(); }); ask(); }); state.approvalActive = false; record({ type: "approval", status: "resolved" }); rl.resume();
    const written = writeApprovalResponse(approvalFile, answer);
    console.log(written.ok ? (answer === "approve" ? "\nApproved. Continuing." : "\nRejected. The run will stop.") : `\n${written.reason}`);
  })();
  const startedAt = new Date().toISOString(); fs.writeFileSync(stateFile, JSON.stringify({ task, repo, status: "running", started_at: startedAt, approval: "not_requested", progress: null }, null, 2)); const config = (() => { try { return require("js-yaml").load(fs.readFileSync(path.join(repo, "minitok.yml"), "utf8")) || {}; } catch { return {}; } })(); const roles = Object.fromEntries(["plan", "work", "review", "intel"].map(role => [role, { provider: config.roles?.[role]?.provider || null, model: config.roles?.[role]?.model || null }])); fs.writeFileSync(contextFile, JSON.stringify({ task, repo, started_at: startedAt, context: task.split("\n").filter(line => line.startsWith("@")), prompt_sequence: [task], roles }, null, 2));
  try { const result = await runPipeline(task, { repoRoot: repo, approvalFile, signal: abort.signal, onProgress: event => { record({ type: "progress", progress: event }); if (process.env.MINITOK_LOG_FILTER && event.phase !== process.env.MINITOK_LOG_FILTER) return; try { fs.writeFileSync(stateFile, JSON.stringify({ task, repo, status: "running", started_at: startedAt, approval: state.approvalActive ? "pending" : "not_requested", progress: event }, null, 2)); } catch {} const line = `[${event.phase}] ${event.state}${event.total_tokens ? ` · tokens=${event.total_tokens}` : ""}${event.total_cost ? ` · cost=$${event.total_cost}` : ""}`; process.stdout.write(`\r${line.slice(0, Math.max(20, process.stdout.columns || 80)).padEnd(Math.max(20, process.stdout.columns || 80))}`) } }); fs.writeFileSync(stateFile, JSON.stringify({ task, status: result.success ? "completed" : "failed", completed_at: new Date().toISOString(), result: { cycles: result.cycles, totalTokens: result.totalTokens, totalCost: result.totalCost } }, null, 2)); console.log(`\n${result.success ? "Completed" : "Failed"}\nrun_id=${result.run_id || "recorded in evidence"}`); return result; } catch (error) { try { fs.writeFileSync(stateFile, JSON.stringify({ task, status: abort.signal.aborted ? "cancelled" : "failed", resume_hint: abort.signal.aborted ? "Retry this task with :resume or a new prompt." : undefined, completed_at: new Date().toISOString(), error: error.message }, null, 2)); } catch {} console.error(`\nError: ${error.message}`); console.log(/entitlement|activation/i.test(error.message) ? "Recovery: run minitok activate <key>" : /provider|api|model/i.test(error.message) ? "Recovery: use :settings" : "Recovery: inspect :status or retry."); throw error; } finally { approvalWatcherDone = true; process.removeListener("SIGINT", onSigint); state.activeAbort = undefined; try { fs.rmSync(approvalFile, { force: true }); fs.rmSync(`${approvalFile}.response`, { force: true }); } catch {} }
}
module.exports = { runTask, writeApprovalResponse };

/**
 * Bounded-text helpers for command task construction.
 *
 * This lives outside `extension.ts` because that module imports `vscode`, which
 * makes the logic unreachable from a plain Node test. Truncation must always be
 * signalled to the model — a silently clipped selection or diagnostics list
 * makes the CLI propose fixes from an incomplete picture. See
 * `test/truncate.test.js`.
 */

/** Hard cap on any block of source/diagnostics text embedded in a task. */
export const MAX_TASK_TEXT_CHARS = 18000;
/** Cap on the number of Problems entries embedded in a task. */
export const MAX_PROBLEM_ENTRIES = 100;

/**
 * Clip `text` to the cap and, when anything was dropped, append a marker so the
 * truncation is visible downstream instead of silent.
 */
export function clipWithNote(text: string, maxChars: number = MAX_TASK_TEXT_CHARS): { text: string; note: string } {
  const clipped = text.length > maxChars ? text.slice(0, maxChars) : text;
  const note = text.length > maxChars ? `[truncated: showing ${maxChars} of ${text.length} chars]` : "";
  return { text: clipped, note };
}

/**
 * Build the Problems task body from per-file diagnostic counts and entries.
 * `entries` are the already-capped lines; `totalDiagnostics` is the uncapped
 * count so a per-file cap can be reported. A char cap is applied on top.
 */
export function buildProblemsTask(entries: string[], totalDiagnostics: number): string {
  const counted = entries.length;
  const { text, note } = clipWithNote(entries.join("\n"));
  const notes: string[] = [];
  if (totalDiagnostics > counted) notes.push(`[truncated: showing ${counted} of ${totalDiagnostics} diagnostics]`);
  if (note) notes.push(note);
  const suffix = notes.length ? `\n\n${notes.join("\n")}` : "";
  return `Fix the following VS Code Problems in this repository, then run the relevant verification.\n\n${text}${suffix}`;
}

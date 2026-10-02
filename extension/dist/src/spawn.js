"use strict";
/**
 * Process launch helpers for the minitok CLI and for npm.
 *
 * This module deliberately does not import `vscode` so the launch decision can be
 * unit tested from plain Node (see `test/spawn.test.js`).
 *
 * Why the Windows branch exists: Node escapes arguments for the MSVCRT parser,
 * which cmd.exe does not understand. Passing a whole command line as one
 * argument therefore produced
 *   'call \"C:\...\minitok.cmd\" \"--version\"' is not recognized as an internal
 *   or external command
 * and every extension command (status, run, mcp token) failed on Windows while
 * `node <cli>/bin/minitok.js` worked. `windowsVerbatimArguments` hands the line
 * to cmd.exe untouched, and a JavaScript entry is launched with node directly so
 * cmd.exe is not involved at all.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchArgumentError = void 0;
exports.quoteCmdArg = quoteCmdArg;
exports.isJavaScriptEntry = isJavaScriptEntry;
exports.isBatchEntry = isBatchEntry;
exports.assertBatchSafeArgs = assertBatchSafeArgs;
exports.spawnSpecFor = spawnSpecFor;
exports.batchCommandLine = batchCommandLine;
exports.npmSpawnSpec = npmSpawnSpec;
function quoteCmdArg(value) {
    return `"${value.replace(/"/g, '\\"')}"`;
}
function isJavaScriptEntry(value) {
    return /\.(?:cjs|mjs|js)$/i.test(value);
}
function isBatchEntry(value) {
    return /\.(?:cmd|bat)$/i.test(value);
}
/** Characters cmd.exe re-parses inside `%*`, which a batch shim cannot escape. */
const BATCH_UNSAFE_ARG = /["&|<>^%!]/;
class BatchArgumentError extends Error {
    constructor(message) {
        super(message);
        this.name = "BatchArgumentError";
    }
}
exports.BatchArgumentError = BatchArgumentError;
/**
 * Refuse to pass cmd.exe metacharacters to a batch shim.
 *
 * A `.cmd` receives `%*` and re-parses it, so a task such as `fix "a" & calc`
 * cannot be transported safely: the quoting that MSVCRT understand does not
 * survive cmd.exe, and the injected text can be executed. Rather than pretend,
 * fail closed with the fix (use the JavaScript entry point, which node receives
 * verbatim, or run the CLI from a terminal).
 */
function assertBatchSafeArgs(command, args, platform) {
    if (platform !== "win32" || !isBatchEntry(command))
        return;
    const unsafe = args.find(arg => BATCH_UNSAFE_ARG.test(arg));
    if (!unsafe)
        return;
    throw new BatchArgumentError(`The minitok CLI resolved to a Windows batch shim (${command}) and an argument contains characters cmd.exe would re-parse: ${JSON.stringify(unsafe.slice(0, 60))}. ` +
        `Set minitok.cliPath to the package entry point (…\\node_modules\\@flotic\\minitok\\bin\\minitok.js) or run minitok from a terminal.`);
}
/**
 * Build the launch spec for a resolved CLI path.
 *
 * - a JavaScript entry is executed by node (no shell involved);
 * - a `.cmd`/`.bat` shim is executed through cmd.exe with the command line
 *   passed verbatim, which is what cmd.exe actually parses;
 * - anything else is executed directly.
 */
function spawnSpecFor(platform, command, args, options = {}) {
    if (isJavaScriptEntry(command) && options.nodePath) {
        return { command: options.nodePath, args: [command, ...args], shell: false, windowsVerbatimArguments: false };
    }
    if (platform !== "win32" || !isBatchEntry(command)) {
        return { command, args, shell: false, windowsVerbatimArguments: false };
    }
    assertBatchSafeArgs(command, args, platform);
    return { command: options.comspec || "cmd.exe", args: ["/d", "/s", "/c", batchCommandLine(command, args)], shell: false, windowsVerbatimArguments: true };
}
/** The `call "shim" "arg"...` line cmd.exe is given, verbatim. */
function batchCommandLine(command, args) {
    return ["call", quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
}
/**
 * npm itself is a batch shim on Windows, so it needs the same treatment:
 * `execFile("npm", ...)` fails with EINVAL on Node 18.20+ and producing the
 * update banner silently never worked.
 */
function npmSpawnSpec(platform, args, options = {}) {
    const npm = platform === "win32" ? "npm.cmd" : "npm";
    return spawnSpecFor(platform, npm, args, options);
}

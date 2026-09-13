/**
 * CLI compatibility gate for the extension.
 *
 * This lives outside `workspace.ts` because that module imports `vscode`, which
 * makes the function unreachable from a plain Node test — and every extension
 * command is gated on this check. See `test/version.test.js`.
 */

export const MINIMUM_CLI_MAJOR = 1;
export const MINIMUM_CLI_MINOR = 3;

export function isCliCompatible(version: string) {
  // The CLI prints `minitok 1.3.12` for `--version`, so the product prefix has
  // to be tolerated; requiring a leading digit rejected every release. The same
  // tolerance already exists in isNodeCli(), which detects the CLI binary.
  const match = /^(?:minitok\s+)?v?(\d+)\.(\d+)\.(\d+)/i.exec(String(version ?? "").trim());
  if (!match) return false;
  // Compare major and minor as a pair. Testing the components independently
  // rejected every future major release (2.0.0 fails `minor >= 3`) while
  // accepting unrelated versions such as 3.3.1.
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MINIMUM_CLI_MAJOR || (major === MINIMUM_CLI_MAJOR && minor >= MINIMUM_CLI_MINOR);
}

import * as path from "node:path";

export const QUOTED_ESCAPES = "\"'\\";

export function parseMcpCommand(value: string) {
  const result: string[] = [];
  let token = "";
  let quote: string | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      // Only a quote, a backslash or whitespace is escapable. A backslash before
      // anything else is a literal path separator: treating every backslash as an
      // escape silently turned "C:\Program Files\node.exe" into
      // "C:Program Filesnodejsnode.exe". Single quotes never escape, as in a shell.
      token += QUOTED_ESCAPES.includes(character) || /\s/.test(character) ? character : `\\${character}`;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) { result.push(token); token = ""; }
    } else {
      token += character;
    }
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("Unclosed quote in minitok.mcpCommand");
  if (token) result.push(token);
  return result;
}

export function packagedMcpCommand(extensionPath: string, nodePath: string) {
  return [nodePath, path.join(extensionPath, "runtime", "src", "runtime", "stdio-entry.js")];
}

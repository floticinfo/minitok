"use strict";
const { spawn } = require("child_process");
const path = require("path");

const entry = path.resolve(__dirname, "..", "src", "runtime", "stdio-entry.js");

function probe(label, extraEnv) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, MINITOK_MCP_AUTH_TOKEN: "e2e-check", ...extraEnv },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk.toString(); });
    child.stdout.on("end", () => resolve({ label, out }));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
    setTimeout(() => { try { child.stdin.end(); } catch {} }, 2000);
  });
}

(async () => {
  const noEnt = await probe("no-entitlement", { MINITOK_ENTITLEMENT: "" });
  console.log(noEnt.label, "=>", noEnt.out.trim().slice(0, 220));
  const withEnt = await probe("with-entitlement", { MINITOK_ENTITLEMENT: "e2e-token" });
  console.log(withEnt.label, "=>", withEnt.out.trim().slice(0, 220));
})();
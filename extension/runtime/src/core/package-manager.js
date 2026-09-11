"use strict";

const { execFileSync } = require("child_process");

function packageManagerCommand(packageManager = "npm", args = []) {
  if (process.platform === "win32" && packageManager === "npm") return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm", ...args] };
  return { command: packageManager, args };
}

function runPackageManager(packageManager, args, options = {}) {
  const invocation = packageManagerCommand(packageManager, args);
  return execFileSync(invocation.command, invocation.args, options);
}

module.exports = { packageManagerCommand, runPackageManager }; 

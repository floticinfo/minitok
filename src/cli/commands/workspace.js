"use strict";

const { WorkspaceManager } = require("../../workspace/manager");
const path = require("path");
const { printError } = require("../output");

async function cmdWsAdd(repoPath, name) {
  try {
    const wm = new WorkspaceManager();
    const resolvedPath = path.resolve(repoPath);
    const wsName = name || path.basename(resolvedPath);
    const ws = wm.add(wsName, resolvedPath);
    // Auto-set as current workspace if it's the first one
    const allWs = wm.listAll();
    const wsKeys = Object.keys(allWs);
    if (wsKeys.length === 1) {
      wm.use(wsName);
      console.log(`  → Set as current workspace`);
    }
    console.log(`Workspace '${ws.name}' registered`);
    console.log(`  repository:  ${ws.repository_root}`);
    console.log(`  workspace:   ${ws.workspace_directory}`);
    console.log(`  project:     ${ws.project_type}`);
    return 0;
  } catch (e) {
    printError(`${e.message}`);
    return 1;
  }
}

async function cmdWsList() {
  const wm = new WorkspaceManager();
  const workspaces = wm.listAll();
  const current = wm.currentName;
  const entries = Object.entries(workspaces);

  if (entries.length === 0) {
    console.log("No workspaces registered.");
    return 0;
  }

  for (const [name, ws] of entries) {
    const marker = name === current ? " *" : "  ";
    console.log(`${marker} ${name.padEnd(20)} ${(ws.repository_root || "").padEnd(40)} [${ws.project_type}]`);
  }
  return 0;
}

async function cmdWsUse(name) {
  try {
    const wm = new WorkspaceManager();
    const ws = wm.use(name);
    console.log(`Switched to workspace '${ws.name}'`);
    return 0;
  } catch (e) {
    printError(`${e.message}`);
    return 1;
  }
}

async function cmdWsCurrent() {
  const wm = new WorkspaceManager();
  const ws = wm.currentWorkspace();
  if (!ws) {
    console.log("No current workspace.");
    return 0;
  }
  console.log(`name:        ${ws.name}`);
  console.log(`repository:  ${ws.repository_root}`);
  console.log(`workspace:   ${ws.workspace_directory}`);
  console.log(`project:     ${ws.project_type}`);
  console.log(`last_used:   ${ws.last_used || "never"}`);
  return 0;
}

async function cmdWsRemove(name) {
  try {
    const wm = new WorkspaceManager();
    wm.remove(name);
    console.log(`Workspace '${name}' removed`);
    return 0;
  } catch (e) {
    printError(`${e.message}`);
    return 1;
  }
}

module.exports = { cmdWsAdd, cmdWsList, cmdWsUse, cmdWsCurrent, cmdWsRemove };

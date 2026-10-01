import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { minitokPanel } from "../src/panel";
import { minitokSidebar } from "../src/sidebar";

export async function run() {
  const extension = vscode.extensions.getExtension("flotic.minitok-extension");
  assert.ok(extension, "minitok extension must be installed in the host");
  const packageJson = extension.packageJSON as { capabilities?: { untrustedWorkspaces?: unknown }; contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> }; commands?: Array<{ command: string }>; views?: Record<string, Array<{ id: string }>> } };
  assert.equal(packageJson.contributes?.configuration?.properties?.["minitok.autoApprove"]?.default, false);
  assert.equal(packageJson.contributes?.configuration?.properties?.["minitok.cliPath"]?.default, "");
  assert.equal(packageJson.contributes?.configuration?.properties?.["minitok.mcpCommand"]?.default, "");
  assert.match(packageJson.contributes?.commands?.map((command: { command: string }) => command.command).join(",") || "", /minitok\.openSettings/);
  assert.deepEqual(packageJson.capabilities?.untrustedWorkspaces, { supported: false, description: "minitok runs repository-changing commands and requires a trusted workspace." });
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("minitok.openPanel"));
  assert.ok(commands.includes("minitok.run"));
  assert.ok(commands.includes("minitok.status"));
  assert.ok(commands.includes("minitok.openSettings"));
  assert.ok(commands.includes("minitok.mcpStatus"));
  const config = vscode.workspace.getConfiguration("minitok");
  assert.equal(config.get<boolean>("autoApprove"), false);
  assert.equal(config.get<string>("cliPath"), "");
  assert.equal(config.get<string>("mcpCommand"), "");
  // The sidebar view must be registered under the id package.json contributes.
  assert.equal(minitokSidebar.viewType, "minitok.sidebar");
  assert.ok(
    packageJson.contributes?.views?.minitok?.some((view: { id: string }) => view.id === minitokSidebar.viewType),
    "sidebar view id must match the contributed view"
  );

  // Opening the panel must create and retain the singleton webview panel.
  assert.equal(minitokPanel.current, undefined, "no panel before openPanel");
  await vscode.commands.executeCommand("minitok.openPanel");
  assert.ok(minitokPanel.current, "minitok.openPanel must create the panel");
  // createOrShow reveals instead of duplicating.
  await vscode.commands.executeCommand("minitok.openPanel");
  assert.ok(minitokPanel.current, "panel singleton must survive a second openPanel");
  console.log("extension_host=pass panel_created=1 sidebar_view=" + minitokSidebar.viewType);
}

if (require.main === module) run().catch(error => { console.error(error); process.exit(1); });

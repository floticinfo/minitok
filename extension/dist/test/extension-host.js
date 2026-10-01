"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const assert = __importStar(require("node:assert/strict"));
const vscode = __importStar(require("vscode"));
const panel_1 = require("../src/panel");
const sidebar_1 = require("../src/sidebar");
async function run() {
    const extension = vscode.extensions.getExtension("flotic.minitok-extension");
    assert.ok(extension, "minitok extension must be installed in the host");
    const packageJson = extension.packageJSON;
    assert.equal(packageJson.contributes?.configuration?.properties?.["minitok.autoApprove"]?.default, false);
    assert.equal(packageJson.contributes?.configuration?.properties?.["minitok.cliPath"]?.default, "");
    assert.equal(packageJson.contributes?.configuration?.properties?.["minitok.mcpCommand"]?.default, "");
    assert.match(packageJson.contributes?.commands?.map((command) => command.command).join(",") || "", /minitok\.openSettings/);
    assert.deepEqual(packageJson.capabilities?.untrustedWorkspaces, { supported: false, description: "minitok runs repository-changing commands and requires a trusted workspace." });
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("minitok.openPanel"));
    assert.ok(commands.includes("minitok.run"));
    assert.ok(commands.includes("minitok.status"));
    assert.ok(commands.includes("minitok.openSettings"));
    assert.ok(commands.includes("minitok.mcpStatus"));
    const config = vscode.workspace.getConfiguration("minitok");
    assert.equal(config.get("autoApprove"), false);
    assert.equal(config.get("cliPath"), "");
    assert.equal(config.get("mcpCommand"), "");
    // The sidebar view must be registered under the id package.json contributes.
    assert.equal(sidebar_1.minitokSidebar.viewType, "minitok.sidebar");
    assert.ok(packageJson.contributes?.views?.minitok?.some((view) => view.id === sidebar_1.minitokSidebar.viewType), "sidebar view id must match the contributed view");
    // Opening the panel must create and retain the singleton webview panel.
    assert.equal(panel_1.minitokPanel.current, undefined, "no panel before openPanel");
    await vscode.commands.executeCommand("minitok.openPanel");
    assert.ok(panel_1.minitokPanel.current, "minitok.openPanel must create the panel");
    // createOrShow reveals instead of duplicating.
    await vscode.commands.executeCommand("minitok.openPanel");
    assert.ok(panel_1.minitokPanel.current, "panel singleton must survive a second openPanel");
    console.log("extension_host=pass panel_created=1 sidebar_view=" + sidebar_1.minitokSidebar.viewType);
}
if (require.main === module)
    run().catch(error => { console.error(error); process.exit(1); });

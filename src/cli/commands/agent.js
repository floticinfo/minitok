"use strict";
const path = require("path");
const { pathToFileURL } = require("url");
const { runtimeTokenPath } = require("../../mcp/runtime-token");
const { resolveServerUrl } = require("./server-config");

async function cmdAgent(task, options = {}) {
  const { resolveMode, assertModeEnabled, requireAbsoluteRepo } = await import(pathToFileURL(path.resolve(__dirname, "../../agent/policy.mjs")).href);
  const mode = resolveMode(options.mode ?? process.env.MINITOK_MODE ?? "on");
  // This gate intentionally precedes token, provider, MCP, and SDK loading.
  assertModeEnabled(mode);

  const repo = requireAbsoluteRepo(options.repo ?? process.cwd());
  const tokenFile = options.tokenFile || process.env.MINITOK_MCP_AUTH_TOKEN_FILE || runtimeTokenPath();
  const serverUrl = resolveServerUrl({ cliServer: options.server });
  const mcpEntry = options.mcpEntry || process.env.MINITOK_MCP_ENTRY || path.resolve(__dirname, "../../runtime/stdio-entry.js");
  const providerId = options.provider || process.env.CLINE_PROVIDER_ID || process.env.MINITOK_PROVIDER || "anthropic";
  const modelId = options.model || process.env.CLINE_MODEL_ID || process.env.MINITOK_MODEL || "claude-sonnet-4-6";
  const apiKeyEnv = options.apiKeyEnv || providerApiKeyEnv(providerId);
  const apiKey = process.env[apiKeyEnv];

  if (!options.status && !task) throw new Error("A task is required unless --status is used.");
  if (!options.status && !apiKey) throw new Error(`Missing provider credential in ${apiKeyEnv}. Use --status for an LLM-free MCP check.`);

  const { readStatus, runTask } = await import(pathToFileURL(path.resolve(__dirname, "../../agent/host.mjs")).href);
  const common = {
    mode,
    tokenFile,
    scopes: options.scopes || process.env.MINITOK_MCP_SCOPES || "read,write,verify_exec",
    serverUrl,
    repo,
    mcpEntry,
    providerId,
    modelId,
    apiKey,
    timeoutMs: options.timeoutMs,
    allowAutoAccept: options.autoAccept === true,
  };
  if (options.status) {
    const response = await readStatus(common);
    return { mode, initialized: response.initialized, status: response.result };
  }
  const response = await runTask({ ...common, task });
  return { mode, tools: response.tools, initialized: response.initialized, result: response.result };
}

function providerApiKeyEnv(provider) {
  const normalized = String(provider).toLowerCase();
  if (["google", "gemini"].includes(normalized)) return "GEMINI_API_KEY";
  if (["openai", "gpt"].includes(normalized)) return "OPENAI_API_KEY";
  if (normalized === "openrouter") return "OPENROUTER_API_KEY";
  return "ANTHROPIC_API_KEY";
}

function register(program) {
  program.command("agent")
    .description("Run an enforced minitok-only agent host")
    .argument("[task]")
    .option("--mode <mode>", "execution gate: on or off", process.env.MINITOK_MODE || "on")
    .option("--status", "check minitok MCP status without invoking an LLM")
    .option("--repo <path>", "absolute repository path")
    .option("--token-file <path>", "MCP runtime token file")
    .option("--server <url>", "minitok server URL")
    .option("--scopes <scopes>", "MCP scopes", "read,write,verify_exec")
    .option("--mcp-entry <path>", "MCP stdio entry point")
    .option("--provider <id>", "provider id")
    .option("--model <id>", "model id")
    .option("--api-key-env <name>", "environment variable containing the provider credential")
    .option("--timeout-ms <ms>", "MCP request timeout", value => Number(value))
    .option("--auto-accept", "request automatic acceptance (server policy still applies)")
    .action(async (task, options) => {
      try {
        const result = await cmdAgent(task, options);
        console.log(JSON.stringify(result));
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = error.code === "MINITOK_MODE_OFF" ? 2 : 1;
      }
    });
}

module.exports = { cmdAgent, register, providerApiKeyEnv };

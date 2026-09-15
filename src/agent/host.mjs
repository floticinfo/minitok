import { Agent } from "@cline/sdk";
import { createMinitokClient } from "./mcp-client.mjs";
import { assertModeEnabled, buildSystemPrompt, resolveMode } from "./policy.mjs";
import { buildToolPolicies, createMinitokTools } from "./tools.mjs";

export async function createHost({ mode, tokenFile, scopes, serverUrl, repo, mcpEntry, mcpCommand, providerId, modelId, apiKey, timeoutMs, allowAutoAccept = false } = {}) {
  const resolvedMode = resolveMode(mode);
  assertModeEnabled(resolvedMode);
  const { client, initialized } = await createMinitokClient({ tokenFile, scopes, serverUrl, cwd: repo, entry: mcpEntry, command: mcpCommand, timeoutMs });
  try {
    const listed = await client.request("tools/list", {});
    const tools = createMinitokTools(client, listed?.tools ?? [], { mode: resolvedMode, cwd: repo, allowAutoAccept });
    if (!tools.length) throw new Error("The minitok MCP server exposed no minitok_* tools.");
    const agent = new Agent({
      providerId,
      modelId,
      apiKey,
      maxIterations: 12,
      systemPrompt: buildSystemPrompt(resolvedMode),
      tools,
      toolPolicies: buildToolPolicies(tools),
    });
    return { agent, client, tools, initialized, mode: resolvedMode };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function runTask(options) {
  const host = await createHost(options);
  try {
    const result = await host.agent.run(options.task);
    return { result, tools: host.tools.map(tool => tool.name), initialized: host.initialized, mode: host.mode };
  } finally {
    await host.client.close();
  }
}

export async function readStatus(options) {
  const mode = resolveMode(options.mode);
  assertModeEnabled(mode);
  const { client, initialized } = await createMinitokClient({ ...options, entry: options.entry || options.mcpEntry, command: options.command || options.mcpCommand });
  try {
    const result = await client.request("tools/call", { name: "minitok_status", arguments: {} });
    return { result, initialized, mode };
  } finally {
    await client.close();
  }
}

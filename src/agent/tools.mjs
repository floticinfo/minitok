import { createTool } from "@cline/sdk";
import { assertModeEnabled, filterMinitokTools, isReadOnlyTool, normalizeRunInput } from "./policy.mjs";

export function createMinitokTools(client, definitions, { mode = "on", cwd = process.cwd(), allowAutoAccept = false } = {}) {
  assertModeEnabled(mode);
  return filterMinitokTools(definitions).map(definition => createTool({
    name: definition.name,
    description: `${definition.description ?? definition.name} This is the only approved execution surface. Do not use direct file or shell tools.`,
    inputSchema: definition.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
    async execute(input) {
      assertModeEnabled(mode);
      const args = definition.name === "minitok_run"
        ? normalizeRunInput(input, cwd, { allowAutoAccept })
        : (input ?? {});
      return client.request("tools/call", { name: definition.name, arguments: args });
    },
  }));
}

export function buildToolPolicies(tools) {
  return Object.fromEntries(tools.map(tool => [tool.name, { autoApprove: isReadOnlyTool(tool.name) }]));
}

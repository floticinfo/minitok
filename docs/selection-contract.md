# Selection contract

CLI, VS Code Extension, and MCP use the same non-secret selection shape:

```json
{
  "schema_version": 1,
  "workspace_root": "C:\\path\\to\\repository",
  "provider": "openai",
  "selected_at": "2026-09-18T00:00:00.000Z"
}
```

## CLI

The CLI stores this shape at:

```text
<workspace_root>/.minitok/selection.json
```

Only the workspace root, canonical provider name, schema version, and timestamp are stored. API keys, OAuth tokens, and account identifiers are never written to this file.

## Extension

The Extension stores the same fields in `workspaceState` under:

```text
minitok.discovery.selection
```

Before reuse, it verifies that the workspace root is the currently open folder and that the provider is still present and authenticated in the latest discovery response. Invalid selections are removed.

## MCP

MCP selection is session-scoped and is not persisted to disk. `minitok_discover` returns a non-secret `selection_id` when a host must choose a provider. The host must call `minitok_discover` again with that `selection_id` and a candidate `provider_override`. Only a selection promoted to `selected` can be passed to `minitok_run`.

A selection is rejected when:

- the selection id is unknown or belongs to another workspace;
- the provider is not one of the discovered candidates;
- the selection is still `approval_required`;
- the MCP runtime has restarted.

`auto_accept` and provider selection are separate decisions. Provider selection never grants permission to modify files or execute verification commands.

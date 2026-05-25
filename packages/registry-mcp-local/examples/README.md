# MCP config examples

Ready-to-paste configs for hooking the local registry MCP into AI coding tools.

## Pick the right file

| Your situation | Use |
|---|---|
| Trying out registry-mcp-local on its own | `claude-code-mcp.json` (or cursor / windsurf equivalents) |
| Hacking on registry-mcp-local inside this monorepo | `dev-mode-mcp.json` |
| Already have other MCPs configured | Merge the `mcpServers.projex-registry` entry into your existing config |

## Where each tool reads its config from

| Tool | Path |
|---|---|
| Claude Code | `~/.claude/mcp.json` |
| Cursor | `<project>/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline | `~/Library/Application Support/Cline/cline_mcp_settings.json` (macOS) — adjust for OS |

## Verify it loaded

After restarting your AI tool, ask:

> "List the tools you have available."

You should see the 6 `projex_registry_*` tools mixed in with any others you
have configured. If you don't, check the tool's MCP log — most ship a UI for
this (Claude Code: bottom-left status bar → MCP).

## Quick prompts to test

```
"Search ProjexCloud SDKs for: consent management for healthcare"
→ calls projex_registry_search_sdks → returns ranked SDKs

"Show me the full manifest for @projexlight/sdk-vault"
→ calls projex_registry_get_manifest → returns endpoints, events, scenarios, compliance

"What SDKs compose with @projexlight/sdk-vault?"
→ calls projex_registry_list_compatible_sdks → returns SDKs whose
  consumes.events overlap with sdk-vault's provides.events
```

## Cohabitation with the Projexlight dev MCP

If you already use the Projexlight dev MCP (`projex_dev_mcp`), keep it. The
tools prefixed `projexlight_*` are Projexlight's; the tools prefixed
`projex_registry_*` are ProjexCloud's. Zero collision. Your AI sees both
tool sets in one session and routes calls by tool name.

Example merged Claude Code config:

```json
{
  "mcpServers": {
    "projexlight": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "projexlight/projex-dev-mcp:latest"]
    },
    "projex-registry": {
      "command": "npx",
      "args": ["-y", "@projexlight/registry-mcp-local"]
    }
  }
}
```

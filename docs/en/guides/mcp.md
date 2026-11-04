# Connect MCP tools

English | [简体中文](../../zh-CN/guides/mcp.md) | [Docs home](../README.md)

## Add a server

Create `mcp.json` in the ArkCode configuration directory. The following is a user-level example; replace the command, file path, tool names, and URL:

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["/path/to/server.mjs"],
      "enabledTools": ["read_*", "search_*"],
      "disabledTools": ["read_secret"]
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "bearerTokenEnvVar": "MY_MCP_TOKEN"
    }
  }
}
```

Connecting a local service executes the command in the config. Put shared project configuration in workspace `.arkcode/mcp.json` and trust that workspace. A project entry with the same name replaces the user entry completely.

Run `/mcp reload`, then use `/mcp status` for status and `/mcp tools local` for tools. First startup, new sessions, and resumed sessions wait for enabled servers to finish tool discovery. In interactive mode, a failure asks you to retry or continue with currently available tools; non-interactive startup reports an error.

## Manage connections

`/mcp` opens a temporary menu to view tools, reconnect, enable or disable servers, and change exposure. Esc or Ctrl+C returns one level at a time and keeps the chat and draft. Status and tool lists can be viewed during a run; changing connections requires idle.

`/mcp reconnect local` rereads config and rebuilds the named server; without a name it reloads all. Enable and disable write back to the config file of the defining server; if external changes conflict, reload first.

## Complete OAuth authorization

When a server requires OAuth, run `/mcp login remote`, follow the link in the browser, and paste the callback URL when needed. On success the server reconnects automatically. `/mcp logout remote` deletes the credentials and disconnects. Interrupting or exiting cancels login.

Local stdio servers and servers with an existing header or bearer token do not show an OAuth login action. Whether login and logout are available depends on the server challenge and saved credentials.

## Choose tool exposure

The default `codemode` lets the model discover tools on demand inside scripts. Use `/mcp exposure local direct` to save another mode. After the first model request, exposure changes apply in a new session or after a successful compaction; disabling, removing, and filtering tools blocks actual calls immediately.

Exposure is not approval to call. MCP follows [permissions rules](permissions.md); auto-approval and all fields are in the [MCP configuration reference](../reference/mcp-config.md). For connection diagnostics, see [Troubleshooting](../troubleshooting.md).

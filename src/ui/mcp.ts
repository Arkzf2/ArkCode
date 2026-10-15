import type { Choice, UserInterface } from "../app/types.js";
import type { McpManager } from "../integrations/mcp/manager.js";

const hint = "↑/↓ select · Enter open · Esc/Ctrl+C back · /mcp help";

export async function browseMcp(options: {
  ui: UserInterface;
  mcp: McpManager;
  active: () => boolean;
  canManage: () => boolean;
  execute: (args: string[]) => Promise<void>;
}): Promise<void> {
  const { ui, mcp } = options;
  let selectedServer: string | undefined;
  while (options.active()) {
    const servers: Choice[] = mcp.statuses.map(({ entry, state }) => ({
      value: entry.name, label: entry.name, description: `${entry.scope} | ${entry.config.transport}`,
      status: { text: state.kind, tone: state.kind === "connected" ? "positive" : state.kind === "disconnected" || state.kind === "closed" || state.kind === "disabled" ? "muted" : "neutral" },
    }));
    const rootChoices = [...servers,
      ...(options.canManage() ? [{ value: ":reload", label: "Reload configuration" }] : []),
      { value: ":help", label: "Help" },
    ];
    const name = await ui.choose("MCP servers", rootChoices, {
      transient: true, hint, initialValue: selectedServer,
      notice: servers.length ? undefined : mcp.statusText(),
    });
    if (!name || !options.active()) return;
    if (name === ":help") { await ui.inspect("MCP help", mcp.helpText()); continue; }
    if (name === ":reload") { await options.execute(["reload"]); continue; }
    selectedServer = name;
    let selectedAction = "tools";
    while (options.active()) {
      const server = mcp.statuses.find(({ entry }) => entry.name === name);
      if (!server) break;
      const action = await ui.choose(`MCP ${name}`, [
        { value: "tools", label: "Tools", description: `${server.tools.length} tools | ${server.entry.config.exposure}` },
        ...(options.canManage() ? [
          { value: "reconnect", label: "Reconnect" },
          ...(server.canSignIn ? [{ value: "login", label: "Sign in with OAuth" }] : []),
          ...(server.canSignOut ? [{ value: "logout", label: "Sign out" }] : []),
          { value: server.entry.config.enabled ? "disable" : "enable", label: server.entry.config.enabled ? "Disable" : "Enable" },
          { value: "exposure", label: "Tool exposure", description: server.entry.config.exposure },
        ] : []),
      ], { transient: true, hint, initialValue: selectedAction });
      if (!action || !options.active()) break;
      selectedAction = action;
      if (action === "exposure") {
        const exposure = await ui.choose(`MCP ${name} exposure`, ["codemode", "deferred", "direct", "hidden"].map((value) => ({ value, label: value })), {
          transient: true, hint, initialValue: server.entry.config.exposure,
        });
        if (!exposure || !options.active()) continue;
        await options.execute([action, name, exposure]);
      } else await options.execute([action, name]);
    }
  }
}

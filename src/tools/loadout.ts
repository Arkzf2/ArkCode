import { createCodemodeExtension, createToolSearchExtension, type ExtensionAPI, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { SessionToolSettings } from "../session/tool-settings.js";
import type { McpManager } from "../integrations/mcp/manager.js";
import { TOOL_NAMES } from "./index.js";
import { builtinExposure } from "./mode.js";

export function createToolLoadout(options: {
  settings: SessionToolSettings; tools: ToolDefinition[]; mcp: McpManager; resetApprovals: () => void;
}): ExtensionFactory {
  return (pi) => {
    const { settings, tools, mcp } = options;
    let restored: string[] = [];
    const discoveryTools = () => [...mcp.discoveryTools(), ...(settings.current.toolMode !== "direct" ? ["codemode"] : [])];
    const discoveryApi: ExtensionAPI = { ...pi,
      registerTool(tool) {
        pi.registerTool({ ...tool, prepareLoadout: (loadout) => {
          const prepared = tool.prepareLoadout?.(loadout);
          return discoveryTools().includes(tool.name) ? prepared : { ...prepared,
            hiddenDeclarations: [...(prepared?.hiddenDeclarations ?? []), tool.name],
          };
        } });
      },
    };
    createCodemodeExtension({ mode: "on", models: false })(discoveryApi);
    createToolSearchExtension()({ ...discoveryApi, getAllTools: () => pi.getAllTools().filter((tool) => !TOOL_NAMES.includes(tool.name)) });
    const register = () => {
      for (const tool of tools) pi.registerTool({ ...tool, exposure: builtinExposure(settings.current.toolMode) });
    };
    const activate = () => {
      const discovery = discoveryTools();
      const active = [...pi.getActiveTools(), ...restored].filter((name) => {
        if (TOOL_NAMES.includes(name)) return settings.current.toolMode !== "codemode-only";
        if (name === "codemode" || name === "tool_search") return discovery.includes(name);
        return true;
      });
      if (settings.current.toolMode !== "codemode-only") active.push(...TOOL_NAMES);
      pi.setActiveTools([...new Set([...active, ...discovery])]);
    };
    register();
    pi.on("session_start", (_event, ctx) => {
      restored = getCurrentTools(ctx.sessionManager.buildSessionProjection().messages).map((tool) => tool.name)
        .filter((name) => !TOOL_NAMES.includes(name) && name !== "codemode" && name !== "tool_search");
      activate();
    });
    pi.on("before_agent_start", () => { settings.ready(); activate(); restored = []; });
    pi.on("session_compact", async () => {
      const previous = settings.current;
      try {
        const next = settings.defaults();
        const changedMcp = JSON.stringify(next.mcp) !== JSON.stringify(settings.current.mcp);
        const changed = JSON.stringify(next) !== JSON.stringify(settings.current);
        settings.current = next;
        restored = [];
        if (changed) {
          options.resetApprovals();
          register();
          if (changedMcp) await mcp.applyExposure();
          activate();
        }
        settings.persist();
        settings.clearFailure();
      } catch (error) { settings.current = previous; settings.block(error); throw error; }
    });
  };
}

import { createCodemodeExtension, createToolSearchExtension, type ExtensionAPI, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { SessionToolSettings } from "../session/tool-settings.js";
import type { McpManager } from "../integrations/mcp/manager.js";
import { TOOL_NAMES } from "./index.js";
import { builtinExposure } from "./mode.js";
import { builtinToolModePrompt, mcpToolModesPrompt } from "../context/tool-modes.js";

export function createToolLoadout(options: {
  settings: SessionToolSettings; tools: () => ToolDefinition[]; mcp: McpManager; shellInstructions: () => string; resetApprovals: () => void;
}): ExtensionFactory {
  return (pi) => {
    const { settings, mcp } = options;
    let currentShell = options.shellInstructions();
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
    createToolSearchExtension()({ ...discoveryApi, getAllTools: () => pi.getAllTools().filter((tool) => ![...TOOL_NAMES, "WebSearch"].includes(tool.name)) });
    const register = () => {
      for (const tool of options.tools()) pi.registerTool({ ...tool, exposure: builtinExposure(settings.current.toolMode) });
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
    const refreshShell = () => {
      const current = options.shellInstructions();
      if (current === currentShell) return;
      options.resetApprovals();
      register();
      activate();
      currentShell = current;
    };
    pi.on("turn_end", refreshShell);
    pi.on("session_start", (_event, ctx) => {
      restored = getCurrentTools(ctx.sessionManager.buildSessionProjection().messages).map((tool) => tool.name)
        .filter((name) => !TOOL_NAMES.includes(name) && name !== "codemode" && name !== "tool_search");
      activate();
    });
    const apply = async (next: typeof settings.current, force = false) => {
      const changedMcp = force || JSON.stringify(next.mcp) !== JSON.stringify(settings.current.mcp);
      const changed = force || JSON.stringify(next) !== JSON.stringify(settings.current);
      settings.current = next;
      restored = [];
      if (changed) {
        options.resetApprovals();
        register();
        if (changedMcp) await mcp.applyExposure();
        activate();
      }
      settings.clearFailure();
    };
    settings.installApply(apply);
    const applyPending = async () => {
      const staged = await settings.stage();
      try { settings.persist(); }
      catch (error) { await staged.rollback(); throw error; }
    };
    pi.on("before_agent_start", async (event) => {
      refreshShell();
      settings.ready();
      if (settings.canApplyBeforeRequest) await applyPending();
      activate(); restored = [];
      event.systemPromptOptions.sectionProviders.builtin_tool_mode = () => builtinToolModePrompt(settings.current.toolMode);
      event.systemPromptOptions.sectionProviders.mcp_tool_modes = () => mcpToolModesPrompt(mcp.exposures());
      event.systemPromptOptions.sectionProviders.shell_environment = options.shellInstructions;
    });
    pi.on("before_provider_request", () => { settings.markRequested(); });
  };
}

import type { McpServerConfig } from "../integrations/mcp/config.js";
import type { ToolMode } from "../tools/mode.js";

const builtinPrompts = {
  direct: `Built-in tool mode: direct.
Call read, write, edit, grep, glob, and bash directly using their tool declarations. These built-in tools are unavailable inside codemode scripts. A codemode tool provided for MCP does not change how you call the built-in tools.`,
  codemode: `Built-in tool mode: codemode.
You can call read, write, edit, grep, glob, and bash directly or through tools.<name>() in codemode. Use direct calls for simple operations. Prefer codemode to batch independent calls, chain dependent operations, or filter large results before returning them to the conversation.
Await every tool call. For independent calls, use Promise.allSettled and inspect every result. Keep dependent operations and conflicting writes sequential. Return the evidence needed for the task with text(), image(), or a top-level return.`,
  "codemode-only": `Built-in tool mode: codemode-only.
Access read, write, edit, grep, glob, and bash through tools.<name>() inside codemode. These built-in tools have no direct tool declarations; tool_search does not activate them. This restriction applies to built-in tools; MCP tools follow their own exposure modes.
Await every tool call. For independent calls, use Promise.allSettled and inspect every result. Keep dependent operations and conflicting writes sequential. Filter large results in the script and return the evidence needed for the task with text(), image(), or a top-level return.`,
} satisfies Record<ToolMode, string>;

const mcpPrompts = {
  direct: `direct: MCP tools are declared for direct calls. Use their current names and parameter schemas. If codemode is available, these tools can also be called from its scripts.`,
  codemode: `codemode: Access these MCP tools through codemode. Use the catalog in the codemode description. For tools omitted from the catalog, use searchTools(), describeTool(), or describeNamespace() inside the script to discover their names and schemas before calling them. Await calls and return the relevant results.`,
  deferred: `deferred: These MCP tools are discovered on demand. Use tool_search to find an appropriate tool and load its declaration, then call it using the returned name and schema. If codemode is available, you can also discover and call these tools inside a script using searchTools() and describeTool().`,
} satisfies Record<Exclude<McpServerConfig["exposure"], "hidden">, string>;

export function builtinToolModePrompt(mode: ToolMode): string { return builtinPrompts[mode]; }

export function mcpToolModesPrompt(exposures: readonly McpServerConfig["exposure"][]): string {
  const modes = (["direct", "codemode", "deferred"] as const).filter((mode) => exposures.includes(mode));
  if (!modes.length) return "";
  return ["MCP tool exposure is independent of the built-in tool mode and can differ by server or tool. Use the current declarations and discovery results to determine which tools you can call.",
    ...modes.map((mode) => mcpPrompts[mode]),
  ].join("\n\n");
}

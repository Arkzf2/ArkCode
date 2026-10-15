import type { UserInterface } from "../app/types.js";
import { toolModeSchema, type ToolMode } from "../tools/mode.js";

export async function browseToolMode(options: {
  ui: UserInterface; current: () => ToolMode; pending: () => ToolMode;
  save: (mode: ToolMode) => void; active: () => boolean;
}): Promise<void> {
  while (options.active()) {
    const current = options.current();
    const pending = options.pending();
    const value = await options.ui.choose("Tool mode", [
      { value: "direct", label: "Direct", description: "Call built-in tools directly" },
      { value: "codemode", label: "CodeMode", description: "Call built-in tools directly or from scripts" },
      { value: "codemode-only", label: "CodeMode only", description: "Call built-in tools only from scripts" },
    ], { transient: true, initialValue: pending, hint: "↑/↓ select · Enter save · Esc/Ctrl+C back",
      notice: `Built-in tools\nCurrent: ${current}${current !== pending ? `\nPending: ${pending}` : ""}\nChanges apply after successful compact or to new sessions. MCP exposure is configured in /mcp.`,
    });
    if (!value || !options.active()) return;
    options.save(toolModeSchema.parse(value));
  }
}

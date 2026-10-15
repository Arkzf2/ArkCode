import { resolve } from "node:path";
import { z } from "zod";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/settings.js";
import { loadMcpConfig, type McpEntry } from "../integrations/mcp/config.js";
import { toolModeSchema } from "../tools/mode.js";

const exposureSchema = z.enum(["direct", "codemode", "deferred", "hidden"]);
const snapshotSchema = z.object({
  version: z.literal(1),
  toolMode: toolModeSchema,
  mcp: z.array(z.object({
    key: z.string(), exposure: exposureSchema,
    toolExposure: z.record(z.string(), exposureSchema).optional(),
  }).strict()),
}).strict();
export type ToolSettingsSnapshot = z.infer<typeof snapshotSchema>;
export const TOOL_SETTINGS_ENTRY = "arkcode-tool-settings";

function serverKey(entry: McpEntry): string {
  const path = resolve(entry.source);
  return JSON.stringify([entry.scope, process.platform === "win32" ? path.toLowerCase() : path, entry.name]);
}

export class SessionToolSettings {
  current: ToolSettingsSnapshot;
  private failure: { error: unknown } | null = null;

  constructor(private manager: SessionManager, private options: { home: string; cwd: string; trusted: boolean }) {
    let saved: ToolSettingsSnapshot | undefined;
    let compacted = false;
    let hasHistory = false;
    for (const entry of manager.getBranch()) {
      if (entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction") hasHistory = true;
      if (entry.type === "custom" && entry.customType === TOOL_SETTINGS_ENTRY) {
        saved = snapshotSchema.parse(entry.data);
        compacted = false;
      } else if (entry.type === "compaction" && saved) compacted = true;
    }
    this.current = saved && !compacted ? saved : this.defaults();
    if (!saved && hasHistory) this.current.toolMode = "codemode";
    if (!saved || compacted) this.persist();
  }

  defaults(): ToolSettingsSnapshot {
    return { version: 1, toolMode: loadConfig(this.options.home).toolMode,
      mcp: loadMcpConfig(this.options).entries.map((entry) => ({ key: serverKey(entry),
        exposure: entry.config.exposure, toolExposure: entry.config.toolExposure,
      })).sort((left, right) => left.key.localeCompare(right.key)),
    };
  }

  exposure(entry: McpEntry): Pick<McpEntry["config"], "exposure" | "toolExposure"> {
    const saved = this.current.mcp.find(({ key }) => key === serverKey(entry));
    return saved ? { exposure: saved.exposure, toolExposure: saved.toolExposure } : { exposure: "hidden", toolExposure: {} };
  }

  persist(): void { this.manager.appendCustomEntry(TOOL_SETTINGS_ENTRY, this.current); }
  block(error: unknown): void { this.failure = { error }; }
  ready(): void {
    if (this.failure) throw new Error("Tool configuration could not be applied. Retry compact or start a new session.", { cause: this.failure.error });
  }
  clearFailure(): void { this.failure = null; }
}

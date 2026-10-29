import { resolve } from "node:path";
import { z } from "zod";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/settings.js";
import { loadMcpConfig, mcpConfigurationErrors, type McpEntry } from "../integrations/mcp/config.js";
import { latestCheckpoint, toolSettingsSnapshotSchema } from "../compaction/checkpoint.js";

const requestStateSchema = z.object({ version: z.literal(1), requested: z.boolean() }).strict();
const snapshotSchema = toolSettingsSnapshotSchema;
export type ToolSettingsSnapshot = z.infer<typeof snapshotSchema>;
export const TOOL_SETTINGS_ENTRY = "arkcode-tool-settings";
export const TOOL_REQUEST_STATE_ENTRY = "arkcode-tool-request-state";

function serverKey(entry: McpEntry): string {
  const path = resolve(entry.source);
  return JSON.stringify([entry.scope, process.platform === "win32" ? path.toLowerCase() : path, entry.name]);
}

export class SessionToolSettings {
  current: ToolSettingsSnapshot;
  private failure: { error: unknown } | null = null;
  private requested: boolean;
  private apply: ((next: ToolSettingsSnapshot, force?: boolean) => Promise<void>) | undefined;

  constructor(private manager: SessionManager, private options: { home: string; cwd: string; trusted: boolean }) {
    let saved: ToolSettingsSnapshot | undefined;
    let compacted = false;
    let hasHistory = false;
    let requested: boolean | undefined;
    for (const entry of manager.getBranch()) {
      if (entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction") hasHistory = true;
      if (entry.type === "custom" && entry.customType === TOOL_REQUEST_STATE_ENTRY) requested = requestStateSchema.parse(entry.data).requested;
      if (entry.type === "custom" && entry.customType === TOOL_SETTINGS_ENTRY) {
        saved = snapshotSchema.parse(entry.data);
        compacted = false;
      } else if (entry.type === "compaction" && saved) compacted = true;
    }
    const checkpoint = latestCheckpoint(manager);
    if (checkpoint) { saved = checkpoint.checkpoint.toolSettings; compacted = false; }
    this.current = saved && !compacted ? saved : this.defaults();
    this.requested = requested ?? hasHistory;
    if (!saved && hasHistory) this.current.toolMode = "codemode";
    if (!saved || compacted) this.persist();
    if (requested === undefined) this.persistRequestState();
  }

  get canApplyBeforeRequest(): boolean { return !this.requested; }
  get needsRecovery(): boolean { return this.failure !== null; }
  markRequested(): void {
    if (this.requested) return;
    this.requested = true;
    this.persistRequestState();
  }
  private persistRequestState(): void {
    this.manager.appendCustomEntry(TOOL_REQUEST_STATE_ENTRY, { version: 1, requested: this.requested });
  }

  defaults(): ToolSettingsSnapshot {
    const mcp = loadMcpConfig(this.options);
    const errors = mcpConfigurationErrors(mcp);
    if (errors.length) throw new Error(`MCP configuration cannot be applied: ${errors.join("; ")}`);
    return { version: 1, toolMode: loadConfig(this.options.home).toolMode,
      mcp: mcp.entries.map((entry) => ({ key: serverKey(entry),
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
  installApply(apply: (next: ToolSettingsSnapshot, force?: boolean) => Promise<void>): void { this.apply = apply; }
  async restore(snapshot: ToolSettingsSnapshot): Promise<void> {
    if (!this.apply) throw new Error("Tool loadout is not initialized.");
    try { await this.apply(snapshotSchema.parse(snapshot), true); }
    catch (error) { this.block(error); throw error; }
    this.clearFailure();
  }
  async stage(): Promise<{ snapshot: ToolSettingsSnapshot; rollback: () => Promise<void> }> {
    const previous = this.current;
    const snapshot = this.defaults();
    const apply = this.apply;
    if (!apply) throw new Error("Tool loadout is not initialized.");
    const rollback = async () => {
      try { await apply(previous, true); this.clearFailure(); }
      catch (error) { this.block(error); throw error; }
    };
    try { await apply(snapshot); }
    catch (error) { await rollback(); throw error; }
    return { snapshot, rollback };
  }
}

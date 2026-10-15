import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { ApprovalBroker } from "../permissions/approval.js";
import { McpManager } from "../integrations/mcp/manager.js";
import { browseMcp } from "../ui/mcp.js";
import { browseToolMode } from "../ui/tool-mode.js";
import { toolModeSchema, type ToolMode } from "../tools/mode.js";
import { createToolLoadout } from "../tools/loadout.js";
import { SessionToolSettings } from "../session/tool-settings.js";
import { slashCommands } from "../ui/commands.js";
import { configureConnection, createModelRuntime, createResources, loadConfig, saveConfig, selectModel, type ArkConfig, type ConnectionRequest } from "../config/settings.js";
import { WorkspaceLease, hasActiveWorkspaceRun, inspectSession, listArkSessions, readRunMarker, writeRunMarker } from "../session/storage.js";
import { ManagedShell } from "../tools/shell.js";
import { createTools, TOOL_NAMES, READ_TOOL_NAMES } from "../tools/index.js";
import { cleanOutput } from "../tools/output.js";
import { ToolOutputFiles } from "../tools/output-files.js";
import { workspacePath } from "../tools/workspace.js";
import { compactionTracking, installDynamicContext } from "../context/dynamic.js";
import { installToolAvailability } from "../context/tool-availability.js";
import { parsePermission, permissionLabels } from "../permissions/policy.js";
import { getBranch } from "../ui/review.js";
import { displayUserText, prepareMentions } from "../context/mentions.js";
import type { CliOptions } from "./args.js";
import type { ApprovalRequest, InputMode, Permission, RunState, SessionItem, ToolDetails, UserInterface } from "./types.js";

export function contentText(content: unknown): string {
  if (typeof content === "string") return cleanOutput(content);
  if (!Array.isArray(content)) return "";
  return cleanOutput(content.flatMap((block: unknown) =>
    block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : [],
  ).join("\n"));
}

const unsupported = new Set(["goal", "agent", "plugins", "memories", "plan", "cloud"]);
const toolTargetSchema = z.object({ path: z.string().optional(), command: z.string().optional(), pattern: z.string().optional() });
const toolResultSchema = z.object({ exitCode: z.number().nullable().optional(), diff: z.string().optional() });
const shellHistorySchema = z.object({ id: z.string(), command: z.string(), exitCode: z.number().nullable(), status: z.enum(["running", "completed", "failed", "cancelled"]), output: z.string() });

function toolDetails(args: unknown, name = ""): ToolDetails | undefined {
  if (name.startsWith("mcp__")) return { target: cleanOutput(name) };
  const result = toolTargetSchema.safeParse(args);
  if (!result.success) return undefined;
  const target = result.data.command ?? result.data.path ?? result.data.pattern;
  return target ? { target: cleanOutput(target) } : undefined;
}

function toolResultDetails(value: unknown): ToolDetails | undefined {
  const result = toolResultSchema.safeParse(value);
  if (!result.success) return undefined;
  const { exitCode, diff } = result.data;
  return { ...(typeof exitCode === "number" ? { exitCode } : {}), ...(diff !== undefined ? { diff: cleanOutput(diff) } : {}) };
}

export class ArkHost {
  private config: ArkConfig;
  private runtime: ModelRuntime | null = null;
  private session: AgentSession | null = null;
  private mcp: McpManager | null = null;
  private mcpPanelOpen = false;
  private manager: SessionManager | null = null;
  private toolSettings: SessionToolSettings | null = null;
  private lease: WorkspaceLease | null = null;
  private shell: ManagedShell;
  private state: RunState = { kind: "idle", outcome: null };
  private permission: Permission;
  private trusted = false;
  private broker: ApprovalBroker;
  private unsubscribe: (() => void) | null = null;
  private active: Promise<void> | null = null;
  private closing = false;
  private initializing = true;
  private failure = false;
  private interrupted = false;
  private branch = "No Git";
  private queued: string[] = [];
  private localQueue: string[] = [];
  private lastAnswer = "";
  private storageFailed = false;
  private executionUnconfirmed = false;
  private browsing = false;
  private responseId = "";
  readonly home: string;
  cwd: string;

  constructor(readonly options: CliOptions, private ui: UserInterface) {
    this.home = options.home;
    this.cwd = options.cwd;
    this.config = loadConfig(this.home);
    this.permission = options.permission ?? this.config.permission;
    this.shell = new ManagedShell(this.cwd);
    this.broker = new ApprovalBroker(ui, () => this.effectivePermission(), (request) => this.approvalChanged(request));
  }

  async start(): Promise<void> {
    this.refreshStatus();
    this.lease = await WorkspaceLease.acquire(this.cwd, this.home);
    if (this.closing) { await this.lease.release(); return; }
    this.cwd = this.lease.canonicalCwd;
    this.shell = new ManagedShell(this.cwd);
    this.branch = await getBranch(this.cwd);
    this.trusted = this.config.trustedWorkspaces.some((path) => this.samePath(path, this.cwd));
    if (!this.trusted && !this.options.print && !this.options.trust) {
      const choice = await this.ui.choose(`Trust workspace ${this.cwd}?`, [
        { value: "trust", label: "Trust this workspace", description: "Load AGENTS.md and project MCP servers, which can start local processes. Tool approval follows the selected mode." },
        { value: "continue", label: "Continue without project configuration", description: "Skip project AGENTS.md and MCP servers; default to Always Ask." },
      ]);
      if (choice === "trust") this.options.trust = true;
    }
    if (this.options.trust) {
      this.trusted = true;
      this.config.trustedWorkspaces = [...new Set([...this.config.trustedWorkspaces, this.cwd])];
      saveConfig(this.home, this.config);
    }
    if (!this.trusted && !this.options.permission) this.permission = "always-ask";
    this.runtime = await createModelRuntime(this.home);
    if (this.closing) return;
    if (!this.lease.viewer) {
      if (await hasActiveWorkspaceRun(this.home, this.cwd)) {
        this.executionUnconfirmed = true;
      }
      for (const saved of await SessionManager.list(this.cwd, this.sessionDir())) {
        const marker = await readRunMarker(this.home, saved.id);
        if (marker?.status !== "active") continue;
        this.executionUnconfirmed = true;
        break;
      }
    }
    let manager = SessionManager.create(this.cwd, this.sessionDir());
    if ((this.options.command === "resume" && (this.options.target || this.options.last)) || this.options.command === "fork") {
      const path = await this.resolveSession(this.options.target, this.options.last);
      if (!path) throw new Error("No saved session found in this workspace.");
      await inspectSession(path, this.cwd);
      if (this.options.command === "fork" && this.lease.viewer) throw new Error("Read-only viewer cannot fork a session.");
      manager = this.options.command === "fork" ? SessionManager.forkFrom(path, this.cwd, this.sessionDir()) : SessionManager.open(path, this.sessionDir(), this.cwd);
    }
    await this.replaceSession(manager, true);
    if (this.closing) return;
    this.initializing = false;
    if (this.executionUnconfirmed && this.state.kind === "idle" && this.state.outcome !== "interrupted") this.ui.message("error", `Execution unconfirmed. This workspace is limited to inspection. Inspect files and terminate any orphaned commands before resolving active run markers in ${join(this.home, "runs")}. No tools will be replayed.`);
    if (this.lease.viewer) this.ui.message("info", this.lease.viewerReason
      ? `Read-only viewer. ${this.lease.viewerReason} Session mutations and agent execution are disabled.`
      : "Read-only viewer. Another ArkCode process owns this workspace. Session mutations and agent execution are disabled.");
    if (!this.session?.model) this.ui.message("info", "No model configured. Use /connect, or set a provider API key and open /model.");
    this.refreshStatus();
    if (this.options.command === "resume" && !this.options.target && !this.options.last) await this.browseSessions();
  }

  private samePath(a: string, b: string): boolean { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
  private sessionDir(cwd = this.cwd): string {
    const encoded = Buffer.from(process.platform === "win32" ? cwd.toLowerCase() : cwd).toString("base64url");
    return join(this.home, "sessions", encoded);
  }
  private effectivePermission(): Permission { return this.permission; }
  private async authorizeTool(request: ApprovalRequest): Promise<boolean> {
    if (this.closing || this.lease?.viewer || this.storageFailed || this.interrupted || this.state.kind === "stopping") return false;
    if (this.executionUnconfirmed && (request.invocation?.kind === "mcp" || !READ_TOOL_NAMES.includes(request.tool))) return false;
    return this.broker.authorize(request);
  }
  private approvalChanged(request: ApprovalRequest | null): void {
    if (this.state.kind === "idle" || this.state.kind === "stopping") return;
    this.state = request ? { ...this.state, kind: "awaiting-approval", request } : { kind: "running", id: this.state.id, startedAt: this.state.startedAt };
    this.refreshStatus();
  }
  private refreshStatus(): void {
    const usage = this.session?.getContextUsage();
    this.ui.status({ model: this.session?.model ? `${this.session.model.provider}/${this.session.model.id}` : "No model",
      thinking: this.session?.thinkingLevel ?? this.config.thinking, cwd: this.cwd,
      permission: this.effectivePermission(), branch: this.branch,
      context: usage ?? null,
      state: this.state, queued: [...this.queued, ...this.localQueue.map((input) => `Queued shell: ${input}`)], viewer: this.lease?.viewer ?? false,
      executionBlocked: this.executionUnconfirmed || this.storageFailed,
      initializing: this.initializing,
      mcpServers: this.mcp?.statuses.map(({ entry }) => entry.name) ?? [],
    });
  }
  private async replaceSession(manager: SessionManager, initial = false, target?: {
    cwd: string; lease: WorkspaceLease; shell: ManagedShell; trusted: boolean; permission: Permission; branch: string; executionUnconfirmed: boolean;
  }): Promise<void> {
    const wasInitializing = this.initializing;
    this.initializing = true;
    this.refreshStatus();
    try { await this.initializeSession(manager, initial, target); }
    finally { this.initializing = wasInitializing; this.refreshStatus(); }
  }
  private async initializeSession(manager: SessionManager, initial: boolean, target?: {
    cwd: string; lease: WorkspaceLease; shell: ManagedShell; trusted: boolean; permission: Permission; branch: string; executionUnconfirmed: boolean;
  }): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("Model runtime is not initialized.");
    const cwd = target?.cwd ?? this.cwd;
    const lease = target?.lease ?? this.lease;
    const shell = target?.shell ?? this.shell;
    const trusted = target?.trusted ?? this.trusted;
    const permission = target?.permission ?? this.permission;
    if (lease?.viewer) {
      const header = manager.getHeader();
      manager = SessionManager.inMemory(cwd, undefined, header ? [header, ...manager.getEntries()] : undefined);
    }
    const explicitModel = initial && this.options.model ? await selectModel(runtime, this.options.model, this.config) : undefined;
    const hasHistory = manager.getEntries().some((entry) => entry.type === "message");
    let model = hasHistory ? explicitModel : explicitModel ?? await selectModel(runtime, undefined, this.config);
    if (!hasHistory && !model) {
      if (this.options.print) throw new Error("Select a model with --model or arkcode config before running in print mode.");
      const available = await runtime.getAvailable();
      if (available.length) {
        const selected = await this.ui.choose("Select a model", available.map((item) => ({ value: `${item.provider}/${item.id}`, label: `${item.provider}/${item.id}`, description: item.name })));
        if (!selected) throw new Error("Model selection cancelled.");
        model = await selectModel(runtime, selected, this.config);
        if (model) {
          this.config.provider = model.provider;
          this.config.model = model.id;
          saveConfig(this.home, this.config);
        }
      }
    }
    const toolSettings = new SessionToolSettings(manager, { home: this.home, cwd, trusted });
    const mcp = new McpManager({ home: this.home, cwd, trusted, settings: toolSettings,
      canConnect: () => !this.closing && !this.lease?.viewer && !this.executionUnconfirmed && !this.storageFailed && this.state.kind !== "stopping",
      authorize: (request) => this.authorizeTool(request), warning: (message) => { if (!this.mcpPanelOpen) this.ui.message("error", cleanOutput(message)); },
    });
    const outputFiles = new ToolOutputFiles();
    const extensionLoader = new DefaultResourceLoader({
      cwd, agentDir: this.home, settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: "arkcode-file-tracking", hidden: true, factory: compactionTracking },
        { name: "arkcode-tool-output", hidden: true, factory: (pi) => {
          pi.on("tool_result", async (event) => { await outputFiles.capture(event.toolName, event.details); });
        } },
        { name: "arkcode-tool-loadout", hidden: true, factory: createToolLoadout({ settings: toolSettings, mcp,
          tools: createTools({ cwd, shell, outputFiles, authorize: (request) => this.authorizeTool(request) }),
          resetApprovals: () => this.broker.reset(),
        }) },
        { name: "arkcode-mcp", hidden: true, factory: mcp.extension }],
    });
    await extensionLoader.reload();
    if (extensionLoader.getExtensions().errors.length) throw new Error("Cannot initialize ArkCode extensions.");
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd, agentDir: this.home, modelRuntime: runtime, model,
      thinkingLevel: initial ? this.options.thinking : undefined,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ defaultProvider: this.config.provider, defaultModel: this.config.model,
        defaultThinkingLevel: this.config.thinking, retry: { enabled: true, maxRetries: 2 }, compaction: { enabled: true },
        cacheWarming: "off",
      }),
      resourceLoader: createResources(extensionLoader.getExtensions()),
      tools: [...TOOL_NAMES, "codemode", "tool_search", "mcp__*"],
    });
    installDynamicContext(session, { cwd, home: this.home, shell: shell.executable, trusted, projectDocMaxBytes: this.config.projectDocMaxBytes,
      onWarning: (message) => this.ui.message("info", cleanOutput(message)),
      executionBlocked: () => this.executionUnconfirmed || this.storageFailed || Boolean(this.lease?.viewer),
    });
    installToolAvailability(session, () => toolSettings.ready());
    let marker;
    try { marker = await readRunMarker(this.home, session.sessionId); }
    catch (error) { session.dispose(); throw error; }
    if (this.closing) { session.dispose(); return; }
    const oldLease = this.lease;
    this.unsubscribe?.();
    await this.closeSession("new");
    if (this.closing) { session.dispose(); return; }
    this.broker.reset();
    if (target) {
      this.cwd = cwd;
      this.lease = lease;
      this.shell = shell;
      this.trusted = trusted;
      this.permission = permission;
      this.branch = target.branch;
      this.executionUnconfirmed = target.executionUnconfirmed;
    }
    this.manager = manager;
    this.toolSettings = toolSettings;
    this.session = session;
    this.mcp = mcp;
    this.unsubscribe = session.subscribe((event) => this.event(event));
    this.lastAnswer = "";
    this.state = { kind: "idle", outcome: null };
    const draft = this.ui.draft();
    this.ui.clear();
    this.renderHistory();
    this.ui.setDraft(draft);
    if (modelFallbackMessage) this.ui.message("info", modelFallbackMessage);
    if (marker?.status === "active") {
      this.ui.message("error", "Execution unconfirmed. The previous process ended during a run. Existing files remain. No tool or queued input has been replayed. Inspect the workspace and submit a new instruction.");
      this.state = { kind: "idle", outcome: "interrupted" };
      this.executionUnconfirmed = true;
    }
    await session.bindExtensions({ mode: "print" });
    await this.waitForMcp(mcp);
    this.refreshStatus();
    if (target && oldLease !== lease) await oldLease?.release();
  }
  private async waitForMcp(mcp: McpManager): Promise<void> {
    while (!this.closing) {
      await mcp.waitReady();
      if (this.closing) return;
      const unavailable = mcp.statuses.filter(({ entry, state }) => entry.config.enabled && state.kind !== "connected" && state.kind !== "blocked");
      if (!unavailable.length) return;
      const description = unavailable.map(({ entry, state }) => `${entry.name}: ${state.kind}${state.error ? ` (${state.error})` : ""}`).join("\n");
      if (this.options.print) throw new Error(`MCP startup incomplete:\n${description}`);
      const action = await this.ui.choose(`MCP startup incomplete\n${description}`, [
        { value: "retry", label: "Retry unavailable servers" },
        { value: "continue", label: "Continue with available tools", description: "Unavailable MCP servers will have no tools until reconnected in /mcp." },
      ]);
      if (this.closing) return;
      if (action === "continue") return;
      if (action !== "retry") { await this.exit(); return; }
      await Promise.all(unavailable.map(({ entry }) => mcp.reconnect(entry.name)));
    }
  }
  private renderHistory(): void {
    const details = new Map<string, ToolDetails>();
    for (const entry of this.manager?.getBranch() ?? []) {
      if (entry.type === "custom_message") {
        if (!entry.display) continue;
        if (entry.customType === "arkcode-shell") {
          const receipt = shellHistorySchema.safeParse(entry.details);
          if (receipt.success) {
            const { id, command, output, status, exitCode } = receipt.data;
            this.ui.tool(id, "shell", cleanOutput(output), status === "completed" ? "done" : "error", { target: cleanOutput(command), ...(exitCode !== null ? { exitCode } : {}) });
          } else this.ui.message("info", contentText(entry.content));
        } else this.ui.message("info", contentText(entry.content));
        continue;
      }
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "user") this.ui.message("user", displayUserText(contentText(message.content)));
      else if (message.role === "assistant") {
        for (const [index, block] of message.content.entries()) {
          if (block.type === "toolCall") {
            const target = toolDetails(block.arguments, block.name);
            if (target) details.set(block.id, target);
          } else if (block.type === "thinking" && !block.redacted && block.thinking) {
            this.ui.reasoning(`${randomUUID()}:${index}`, cleanOutput(block.thinking), false);
          }
        }
        const text = contentText(message.content);
        if (text) this.ui.message("assistant", text);
        if ((message.stopReason === "stop" || message.stopReason === "length") && text) this.lastAnswer = text;
      } else if (message.role === "toolResult") {
        for (const call of message.nestedCalls?.calls ?? []) this.ui.tool(call.id, call.name,
          cleanOutput(call.error ?? (call.status === "ok" ? "Completed in CodeMode. Output was consumed by the script." : "Execution unconfirmed.")),
          call.status === "ok" ? "done" : "error", toolDetails(call.arguments, call.name));
        this.ui.tool(message.toolCallId, message.toolName, contentText(message.content), message.isError ? "error" : "done", { ...details.get(message.toolCallId), ...toolResultDetails(message.details) });
      }
      else if (message.role === "bashExecution") this.ui.tool(randomUUID(), "shell", message.output, message.cancelled || message.exitCode !== 0 ? "error" : "done", { target: cleanOutput(message.command), exitCode: message.exitCode });
      else if (message.role === "custom" && message.customType === "arkcode-shell") {
        const receipt = shellHistorySchema.safeParse(message.details);
        if (receipt.success) {
          const { id, command, output, status, exitCode } = receipt.data;
          this.ui.tool(id, "shell", cleanOutput(output), status === "completed" ? "done" : "error", { target: cleanOutput(command), ...(exitCode !== null ? { exitCode } : {}) });
        } else this.ui.message("info", contentText(message.content));
      }
    }
  }
  private event(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "user") this.ui.message("user", displayUserText(contentText(event.message.content)));
        else if (event.message.role === "assistant") this.responseId = randomUUID();
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") this.ui.assistantDelta(cleanOutput(event.assistantMessageEvent.delta));
        else if (event.assistantMessageEvent.type === "text_start") {
          for (const [index, block] of event.assistantMessageEvent.partial.content.entries()) {
            if (block.type === "thinking" && !block.redacted) this.ui.reasoning(`${this.responseId}:${index}`, cleanOutput(block.thinking), false);
          }
        }
        else if (event.assistantMessageEvent.type === "thinking_delta" || event.assistantMessageEvent.type === "thinking_end") {
          const update = event.assistantMessageEvent;
          const block = update.partial.content[update.contentIndex];
          if (block?.type === "thinking" && !block.redacted) this.ui.reasoning(`${this.responseId}:${update.contentIndex}`, cleanOutput(block.thinking), update.type !== "thinking_end");
        }
        return;
      case "message_end":
        if (event.message.role === "assistant") {
          for (const [index, block] of event.message.content.entries()) {
            if (block.type === "thinking" && !block.redacted) this.ui.reasoning(`${this.responseId}:${index}`, cleanOutput(block.thinking), false);
          }
          const text = contentText(event.message.content);
          this.ui.assistantEnd(text);
          if (event.message.stopReason === "error") { this.failure = true; this.ui.message("error", cleanOutput(event.message.errorMessage ?? "Model request failed.")); }
          else if (event.message.stopReason === "aborted") this.interrupted = true;
          else if ((event.message.stopReason === "stop" || event.message.stopReason === "length") && text) this.lastAnswer = text;
        }
        break;
      case "tool_execution_start": this.ui.tool(event.toolCallId, event.toolName, "", "running", toolDetails(event.args, event.toolName)); break;
      case "tool_execution_update": this.ui.tool(event.toolCallId, event.toolName, contentText(event.partialResult.content), "running"); break;
      case "tool_execution_end": this.ui.tool(event.toolCallId, event.toolName, contentText(event.result.content), event.isError ? "error" : "done", toolResultDetails(event.result.details)); break;
      case "queue_update": this.queued = [...event.steering.map((text) => `Instruction pending: ${text}`), ...event.followUp.map((text) => `Queued follow-up: ${text}`)]; break;
      case "auto_retry_start": this.ui.message("info", `Retry ${event.attempt}/${event.maxAttempts}. ${cleanOutput(event.errorMessage)}`); break;
      case "auto_retry_end": if (!event.success && event.finalError) { this.failure = true; this.ui.message("error", cleanOutput(event.finalError)); } else if (event.success) this.failure = false; break;
      case "compaction_start": this.ui.message("info", "Compacting conversation..."); break;
      case "compaction_end": this.ui.message(event.errorMessage ? "error" : "info", event.errorMessage ? cleanOutput(event.errorMessage) : "Conversation compacted. Original history retained."); break;
      case "agent_settled": this.interrupted ||= event.aborted; break;
    }
    this.refreshStatus();
  }

  async submit(text: string, mode: InputMode = "prompt"): Promise<void> {
    if (this.closing || this.initializing) return;
    text = text.trim();
    if (!text) return;
    try {
      if (text.startsWith("/")) { await this.command(text); return; }
      if (this.lease?.viewer) throw new Error("Read-only viewer cannot run an agent or modify a session.");
      if (this.storageFailed) throw new Error("History not saved. Restart after resolving the storage error.");
      const session = this.session;
      if (!session?.model) throw new Error("No model configured. Use /connect or /model.");
      if (this.state.kind === "stopping") throw new Error("Stopping. Wait for process cleanup.");
      if (this.state.kind !== "idle") {
        if (text.startsWith("!")) {
          this.localQueue.push(text); this.refreshStatus(); return;
        }
        const prepared = await prepareMentions(text, this.cwd, session.model.input.includes("image"));
        if (mode === "follow-up") await session.followUp(prepared.text, prepared.images); else await session.steer(prepared.text, prepared.images);
        this.refreshStatus(); return;
      }
      await this.run(text);
    } catch (error) {
      if (!text.startsWith("/")) this.ui.message("user", text);
      this.ui.message("error", cleanOutput(error instanceof Error ? error.message : String(error)));
      this.ui.setDraft(text);
    }
  }
  private async run(text: string): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("No session.");
    const runId = randomUUID();
    const startedAt = Date.now();
    this.failure = false; this.interrupted = false;
    this.state = { kind: "running", id: runId, startedAt };
    this.refreshStatus();
    const work = (async () => {
      try {
        if (!this.executionUnconfirmed) await writeRunMarker(this.home, session.sessionId, { status: "active", runId, startedAt, pid: process.pid, cwd: this.cwd });
        if (this.interrupted) return;
        if (text.startsWith("!")) await this.userShell(text.slice(1).trim(), runId);
        else {
          let prompt;
          try { prompt = await prepareMentions(text, this.cwd, session.model?.input.includes("image") ?? false); }
          catch (error) { this.ui.message("user", text); throw error; }
          if (this.interrupted) return;
          await session.prompt(prompt.text, { images: prompt.images });
        }
        await session.waitForIdle();
        while (!this.interrupted && this.localQueue.length) {
          const next = this.localQueue.shift();
          if (!next) break;
          this.refreshStatus();
          await this.userShell(next.slice(1).trim(), randomUUID());
          await session.waitForIdle();
        }
      } catch (error) {
        if (!this.interrupted) { this.failure = true; this.ui.message("error", cleanOutput(error instanceof Error ? error.message : String(error))); }
      } finally {
        this.broker.cancel();
        await this.shell.stopAll();
        const outcome = this.interrupted ? "interrupted" : this.failure ? "failed" : "completed";
        try {
          if (session.sessionFile && existsSync(session.sessionFile)) await inspectSession(session.sessionFile, this.cwd);
          else if (session.messages.length > 0) throw new Error("Session file is missing.");
          if (!this.executionUnconfirmed) await writeRunMarker(this.home, session.sessionId, { status: this.interrupted ? "interrupted" : "completed", runId, startedAt, endedAt: Date.now(), cwd: this.cwd });
        } catch (error) {
          this.storageFailed = true;
          this.ui.message("error", `History not saved. ${cleanOutput(error instanceof Error ? error.message : String(error))}`);
        }
        this.state = { kind: "idle", outcome: this.storageFailed ? "failed" : outcome };
        this.branch = await getBranch(this.cwd);
        this.active = null;
        this.refreshStatus();
      }
    })();
    this.active = work;
    await work;
  }
  private async userShell(command: string, id: string): Promise<void> {
    if (!command) throw new Error("Use ! followed by a shell command.");
    if (!await this.authorizeTool({ id, tool: "Bash", cwd: this.cwd, description: command,
      invocation: { kind: "shell", command, shell: this.shell.executable },
    })) throw new Error("Shell command denied.");
    if (this.interrupted) return;
    const receipt = await this.shell.execute(command, undefined, (value) => this.ui.tool(value.id, "shell", value.output, "running", { target: cleanOutput(command) }));
    this.ui.tool(receipt.id, "shell", receipt.output + `\nExit code: ${receipt.exitCode ?? "unknown"}`, receipt.status === "completed" ? "done" : "error", { target: cleanOutput(command), ...(receipt.exitCode !== null ? { exitCode: receipt.exitCode } : {}) });
    await this.session?.sendCustomMessage({ customType: "arkcode-shell", content: `User shell command: ${command}\n${receipt.output}\nExit code: ${receipt.exitCode}`, details: receipt, display: true }, { triggerTurn: false });
    this.failure = receipt.status === "failed";
    this.interrupted ||= receipt.status === "cancelled";
  }
  async interrupt(): Promise<void> {
    if (this.state.kind === "idle") { this.broker.cancel(); return; }
    this.interrupted = true;
    this.state = { kind: "stopping", id: this.state.id, startedAt: this.state.startedAt };
    this.broker.cancel();
    const queue = this.session?.clearQueue();
    const returned = [...(queue?.steering ?? []), ...(queue?.followUp ?? []), ...this.localQueue];
    this.localQueue = [];
    if (returned.length) this.ui.setDraft([this.ui.draft(), ...returned].filter(Boolean).join("\n\n"));
    this.queued = [];
    this.refreshStatus();
    await Promise.all([this.session?.abort(), this.shell.stopAll(), this.mcp?.cancelConnecting()]);
    await this.active;
  }
  async exit(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try { await this.interrupt(); this.unsubscribe?.(); await this.closeSession("quit"); await this.lease?.release(); }
    finally { this.ui.stop(); }
  }
  private async closeSession(reason: "new" | "quit"): Promise<void> {
    try {
      await this.mcp?.close();
      await this.session?.extensionRunner.emit({ type: "session_shutdown", reason });
    } finally { this.session?.dispose(); }
  }
  get outcome(): string | null { return this.state.kind === "idle" ? this.state.outcome : null; }

  private async sessionItems(): Promise<SessionItem[]> {
    const saved = await listArkSessions(this.home);
    const currentId = this.session?.sessionId;
    const currentState = this.state.kind === "awaiting-approval" ? "needs-you" : this.state.kind === "idle" ? "ready" : "working";
    const items: SessionItem[] = await Promise.all(saved.map(async (entry) => {
      const current = entry.id === currentId && this.samePath(entry.cwd, this.cwd);
      const marker = current ? null : await readRunMarker(this.home, entry.id);
      return {
        id: entry.id, path: entry.path, cwd: entry.cwd,
        title: entry.name || displayUserText(entry.firstMessage).replace(/\s+/g, " ").slice(0, 100) || "Untitled session",
        preview: displayUserText(entry.firstMessage),
        modified: entry.modified.getTime(),
        state: current ? currentState : marker?.status === "active" ? "unconfirmed" : "inactive",
        current,
        ...(current && this.session?.model ? { model: `${this.session.model.provider}/${this.session.model.id}` } : {}),
      };
    }));
    if (this.session && !items.some((item) => item.current)) {
      const firstPrompt = this.session.messages.find((message) => message.role === "user");
      items.unshift({
        id: this.session.sessionId, path: this.session.sessionFile ?? null, cwd: this.cwd,
        title: this.session.sessionName || (firstPrompt ? displayUserText(contentText(firstPrompt.content)).replace(/\s+/g, " ").slice(0, 100) : "Untitled session"),
        preview: firstPrompt ? displayUserText(contentText(firstPrompt.content)) : "No messages yet",
        modified: Date.now(), state: currentState, current: true,
        ...(this.session.model ? { model: `${this.session.model.provider}/${this.session.model.id}` } : {}),
      });
    }
    return items;
  }

  async browseSessions(): Promise<void> {
    if (this.closing || this.browsing) return;
    this.browsing = true;
    try {
      if (this.state.kind !== "idle") await this.interrupt();
      const items = await this.sessionItems();
      const selection = this.ui.browseSessions
        ? await this.ui.browseSessions(items, async (item) => {
          if (!item.path) return { prompt: item.preview, model: item.model };
          const inspection = await inspectSession(item.path);
          return { lastMessage: inspection.lastMessage, prompt: inspection.prompt, model: inspection.model ?? item.model };
        })
        : await this.ui.choose("Sessions", items.map((item) => ({ value: item.id, label: item.title, description: item.cwd })))
          .then((id) => id ? { kind: "open" as const, item: items.find((item) => item.id === id)! } : null);
      if (!selection) return;
      if (selection.kind === "open" && selection.item.current) return;
      if (this.state.kind !== "idle") await this.interrupt();
      const targetCwd = await realpath(selection.kind === "new" ? selection.cwd : selection.item.cwd);
      const sameWorkspace = this.samePath(targetCwd, this.cwd);
      const dir = this.sessionDir(targetCwd);
      if (selection.kind === "open") {
        if (!selection.item.path) throw new Error("This session has no saved history yet.");
        const actualFile = await realpath(selection.item.path);
        const actualDir = await realpath(dir);
        if (!this.samePath(dirname(actualFile), actualDir)) throw new Error("Session file is outside its project history directory.");
        await inspectSession(selection.item.path, targetCwd);
      }
      if (sameWorkspace) {
        const manager = selection.kind === "new" ? SessionManager.create(this.cwd, dir) : SessionManager.open(selection.item.path!, dir, this.cwd);
        await this.replaceSession(manager);
        return;
      }
      const lease = await WorkspaceLease.acquire(targetCwd, this.home);
      try {
        const trusted = this.config.trustedWorkspaces.some((path) => this.samePath(path, lease.canonicalCwd));
        let allowInstructions = trusted;
        if (!trusted && !this.options.print) {
          const choice = await this.ui.choose(`Trust workspace ${lease.canonicalCwd}?`, [
            { value: "trust", label: "Trust this workspace", description: "Load AGENTS.md and project MCP servers, which can start local processes. Tool approval follows the selected mode." },
            { value: "continue", label: "Continue without project configuration", description: "Skip project AGENTS.md and MCP servers; default to Always Ask." },
          ]);
          if (choice === null) return;
          allowInstructions = choice === "trust";
        }
        const permission: Permission = this.options.permission ?? (allowInstructions ? this.config.permission : "always-ask");
        const executionUnconfirmed = !lease.viewer && await hasActiveWorkspaceRun(this.home, lease.canonicalCwd);
        const manager = selection.kind === "new"
          ? SessionManager.create(lease.canonicalCwd, this.sessionDir(lease.canonicalCwd))
          : SessionManager.open(selection.item.path!, this.sessionDir(lease.canonicalCwd), lease.canonicalCwd);
        await this.replaceSession(manager, false, {
          cwd: lease.canonicalCwd, lease, shell: new ManagedShell(lease.canonicalCwd), trusted: allowInstructions,
          permission, branch: await getBranch(lease.canonicalCwd), executionUnconfirmed,
        });
        if (allowInstructions && !trusted) {
          this.config.trustedWorkspaces = [...new Set([...this.config.trustedWorkspaces, lease.canonicalCwd])];
          saveConfig(this.home, this.config);
        }
      } finally {
        if (this.lease !== lease) await lease.release();
      }
    } catch (error) {
      this.ui.message("error", error instanceof Error ? error.message : String(error));
    } finally { this.browsing = false; }
  }

  private async resolveSession(target?: string, last = false): Promise<string | null> {
    const sessions = await SessionManager.list(this.cwd, this.sessionDir());
    if (last) return sessions[0]?.path ?? null;
    if (target) {
      const matched = sessions.filter((session) => session.id === target || session.id.startsWith(target));
      if (matched.length !== 1) throw new Error(matched.length ? "Session ID is ambiguous." : "Session not found in this workspace.");
      return matched[0]?.path ?? null;
    }
    return this.ui.choose("Resume a saved conversation", sessions.map((session) => ({ value: session.path,
      label: session.name ?? (displayUserText(session.firstMessage).slice(0, 70) || session.id),
      description: `${session.id.slice(0, 8)} | ${session.modified.toLocaleString()} | ${session.messageCount} messages`,
    })));
  }
  async editPrevious(): Promise<void> {
    const session = this.session;
    if (!session || this.lease?.viewer) return;
    if (this.state.kind !== "idle") {
      const queue = session.clearQueue();
      const text = queue.followUp.pop() ?? queue.steering.pop();
      for (const item of queue.steering) await session.steer(item);
      for (const item of queue.followUp) await session.followUp(item);
      if (text) this.ui.setDraft(text);
      return;
    }
    const prompt = [...(this.manager?.getBranch() ?? [])].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
    if (!prompt || prompt.type !== "message" || prompt.message.role !== "user" || !this.manager || !prompt.parentId) return;
    const text = displayUserText(contentText(prompt.message.content));
    const path = this.manager.createBranchedSession(prompt.parentId);
    if (path) { await this.replaceSession(SessionManager.open(path, this.sessionDir(), this.cwd)); this.ui.setDraft(text); }
  }

  private async command(text: string): Promise<void> {
    const [raw = "", ...args] = text.slice(1).split(/\s+/);
    const name = raw.toLowerCase(); const argument = args.join(" ");
    if (unsupported.has(name)) { this.ui.message("info", "Not available in this release."); this.ui.setDraft(text); return; }
    const session = this.session;
    const runtime = this.runtime;
    if (!session || !runtime) throw new Error("Session not initialized.");
    const safeCommands = new Set(["help", "status", "copy", "exit", "resume", "mcp"]);
    if (this.lease?.viewer && !safeCommands.has(name)) throw new Error("Read-only viewer. Session mutations are disabled.");
    const idleCommands = new Set(["new", "resume", "fork", "compact", "init", "connect", "tool-mode"]);
    if (this.state.kind !== "idle" && idleCommands.has(name)) {
      if (!["resume", "fork", "new"].includes(name)) throw new Error("Wait until the current run finishes.");
      await this.interrupt();
    }
    switch (name) {
      case "help": this.ui.message("info", `${slashCommands.map((command) => `/${command.name}`).join(" ")}\nEnter submits or steers. Tab queues a follow-up. Left opens sessions from the empty idle composer. Ctrl+C interrupts or exits when idle. Esc interrupts. Ctrl+T shows tool details. Ctrl+O copies the last answer.`); break;
      case "status": this.ui.message("info", `Permissions: ${this.effectivePermission()}\nWorkspace: ${this.cwd}\nModel: ${session.model?.provider}/${session.model?.id}\nSession: ${session.sessionId}\nHistory: ${session.sessionFile ?? "Not written yet"}\nShell: ${this.shell.executable}\nUsage: ${JSON.stringify(session.getSessionStats())}`); break;
      case "mcp": await this.manageMcp(args); break;
      case "tool-mode": {
        const settings = this.toolSettings;
        if (!settings) throw new Error("Tool settings are not initialized.");
        const save = (mode: ToolMode) => {
          const config = { ...loadConfig(this.home), toolMode: mode };
          saveConfig(this.home, config);
          this.config = config;
        };
        if (argument) save(toolModeSchema.parse(argument));
        else await browseToolMode({ ui: this.ui, current: () => settings.current.toolMode,
          pending: () => loadConfig(this.home).toolMode, save,
          active: () => !this.closing && this.toolSettings === settings,
        });
        break;
      }
      case "model": {
        await runtime.refresh({ allowNetwork: false });
        const models = await runtime.getAvailable();
        const selected = argument || await this.ui.choose("Select a model", models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}`, description: model.name })));
        if (!selected) break;
        const model = await selectModel(runtime, selected, this.config);
        if (!model) throw new Error("No model available.");
        await session.setModel(model);
        this.config.provider = model.provider; this.config.model = model.id;
        const levels = session.getAvailableThinkingLevels();
        const thinking = await this.ui.choose("Thinking level", levels.map((value) => ({ value, label: value })));
        if (thinking) { const level = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).parse(thinking); session.setThinkingLevel(level); this.config.thinking = level; }
        saveConfig(this.home, this.config); break;
      }
      case "permissions": {
        if (this.executionUnconfirmed) throw new Error("Execution unconfirmed. This host is limited to inspection. Inspect the workspace and terminate any orphaned commands before restarting with a new session.");
        const value = argument || await this.ui.choose("Permissions", [
          { value: "always-ask", label: "Always Ask", description: "Allow workspace reading, search and plain ls; approve other actions and MCP calls." },
          { value: "ask-when-needed", label: "Ask When Needed", description: "Allow ordinary built-in actions; approve dangerous commands and MCP tools without user auto-approval." },
          { value: "never-ask", label: "Never Ask", description: "Full access without tool approval." },
        ]);
        if (!value) break;
        const permission = parsePermission(value);
        const config = { ...this.config, permission };
        saveConfig(this.home, config);
        this.config = config;
        this.broker.reset(); this.permission = permission;
        this.ui.message("info", `Permissions: ${permissionLabels[permission]}.`); break;
      }
      case "new": await this.replaceSession(SessionManager.create(this.cwd, this.sessionDir())); break;
      case "resume": {
        if (!argument) await this.browseSessions();
        else { const path = await this.resolveSession(argument, argument === "--last"); if (path) { await inspectSession(path, this.cwd); await this.replaceSession(SessionManager.open(path, this.sessionDir(), this.cwd)); } }
        break;
      }
      case "rename": { const title = argument || await this.ui.input("Session name", session.sessionName ?? ""); if (title) session.setSessionName(title); break; }
      case "fork": {
        const path = argument ? await this.resolveSession(argument) : session.sessionFile;
        if (!path || !existsSync(path)) throw new Error("Send a prompt before forking this session.");
        await inspectSession(path, this.cwd);
        await this.replaceSession(SessionManager.forkFrom(path, this.cwd, this.sessionDir())); break;
      }
      case "compact": await this.runOperation(async () => {
        await session.compact(argument || undefined);
        this.toolSettings?.ready();
      }); break;
      case "copy": if (!this.lastAnswer) throw new Error("No completed answer to copy."); if (!await this.ui.copy(this.lastAnswer)) throw new Error("Clipboard is unavailable."); this.ui.message("info", "Answer copied."); break;
      case "init": {
        if (existsSync(join(this.cwd, "AGENTS.md"))) throw new Error("AGENTS.md already exists. It was not overwritten.");
        await this.run("Inspect this repository and create a concise AGENTS.md with the actual build, test and style conventions. Do not invent commands. Do not modify other files."); break;
      }
      case "connect": await this.connect(); break;
      case "exit": await this.exit(); break;
      default: this.ui.setDraft(text); throw new Error(`Unknown command /${name}. Use /help.`);
    }
    this.refreshStatus();
  }
  private async manageMcp(args: string[]): Promise<void> {
    this.mcpPanelOpen = true;
    try { await this.mcpCommand(args); }
    catch (error) {
      if (this.options.print) throw error;
      if (!this.closing) await this.ui.inspect("MCP", cleanOutput(error instanceof Error ? error.message : String(error)));
    } finally { this.mcpPanelOpen = false; }
  }
  private async mcpCommand(args: string[]): Promise<void> {
    const mcp = this.mcp;
    if (!mcp) throw new Error("MCP is not initialized.");
    const [action = "", name, ...extra] = args;
    if (!action) {
      if (this.options.print) { await this.ui.inspect("MCP servers", mcp.statusText()); return; }
      await browseMcp({ ui: this.ui, mcp,
        active: () => !this.closing && this.mcp === mcp,
        canManage: () => !this.lease?.viewer && !this.executionUnconfirmed && !this.storageFailed && this.state.kind === "idle",
        execute: async (command) => {
          try { await this.mcpCommand(command); }
          catch (error) { if (!this.closing) await this.ui.inspect("MCP", cleanOutput(error instanceof Error ? error.message : String(error))); }
        },
      });
      return;
    }
    if (action === "help" && !name && !extra.length) { await this.ui.inspect("MCP help", mcp.helpText()); return; }
    const exposure = action === "exposure" ? z.enum(["codemode", "deferred", "direct", "hidden"]).safeParse(extra[0]) : undefined;
    if ((action === "exposure" ? extra.length !== 1 || !exposure?.success : extra.length > 0)
      || !["status", "tools", "reload", "reconnect", "enable", "disable", "login", "logout", "exposure"].includes(action)) {
      throw new Error("Usage: /mcp [help|status|tools <server>|reload|reconnect [server]|enable|disable|login|logout <server>|exposure <server> <codemode|deferred|direct|hidden>].");
    }
    if (this.mcp !== mcp) throw new Error("Session changed. Open /mcp again.");
    if (action === "status") { if (name) throw new Error("Use /mcp status without a server name."); await this.ui.inspect("MCP status", mcp.statusText()); return; }
    if (action === "tools") { if (!name) throw new Error("Use /mcp tools <server>."); await this.ui.inspect(`MCP ${name} tools`, mcp.toolsText(name)); return; }
    if (this.lease?.viewer) throw new Error("Read-only viewer cannot manage MCP connections or configuration.");
    if (this.executionUnconfirmed || this.storageFailed) throw new Error("Execution or history is unconfirmed. MCP connections are disabled.");
    if (this.state.kind !== "idle") throw new Error("Wait until the current run finishes before changing MCP connections.");
    if (action === "reload" && name) throw new Error("Use /mcp reload without a server name.");
    if (["enable", "disable", "login", "logout", "exposure"].includes(action) && !name) throw new Error(`Use /mcp ${action} <server>.`);
    if (action === "login" && this.options.print) throw new Error("Use interactive ArkCode for /mcp login.");
    this.broker.reset();
    let authorizationUrl: string | undefined;
    await this.runOperation(async () => {
      if (action === "reload") await mcp.reload();
      else if (action === "reconnect") await mcp.reconnect(name);
      else if (action === "exposure" && name && exposure?.success) await mcp.setExposure(name, exposure.data);
      else if (action === "logout" && name) await mcp.logout(name);
      else if (action === "login" && name) await mcp.login(name, {
        showAuthorizationUrl: (url) => { authorizationUrl = url.href; },
        promptForRedirectUrl: async (signal) => {
          signal.throwIfAborted();
          let onAbort = () => {};
          const cancelled = new Promise<undefined>((resolve) => { onAbort = () => { this.ui.dismiss(); resolve(undefined); }; });
          signal.addEventListener("abort", onAbort, { once: true });
          try { return await Promise.race([this.ui.input(`${authorizationUrl ? `Open this URL to sign in:\n${authorizationUrl}\n\n` : ""}Paste the redirect URL if the browser callback cannot reach ArkCode`).then(async (value) => {
            if (value === null) { await mcp.cancelConnecting(); return undefined; }
            return value;
          }), cancelled]); }
          finally { signal.removeEventListener("abort", onAbort); }
        },
      });
      else if (name) await mcp.setEnabled(name, action === "enable");
    });
    if (!this.closing) await this.ui.inspect("MCP status", mcp.statusText());
  }
  private async runOperation(operation: () => Promise<unknown>): Promise<void> {
    this.interrupted = false;
    this.failure = false;
    const id = randomUUID(); this.state = { kind: "running", id, startedAt: Date.now() }; this.refreshStatus();
    const work = (async () => {
      try { await operation(); }
      catch (error) { this.failure = true; throw error; }
      finally {
        this.state = { kind: "idle", outcome: this.interrupted ? "interrupted" : this.failure ? "failed" : "completed" };
        this.active = null;
        this.refreshStatus();
      }
    })();
    this.active = work; await work;
  }
  private async connect(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("Model runtime is not initialized.");
    const kind = await this.ui.choose("Connect model", [
      { value: "builtin", label: "Pi provider", description: "Use Pi's model catalog and capabilities" },
      { value: "custom", label: "Custom endpoint", description: "Define the API and model capabilities" },
    ]);
    if (!kind) return;
    let request: ConnectionRequest;
    let key: string | null | undefined;
    if (kind === "builtin") {
      const provider = await this.ui.choose("Provider", builtinProviders().map((item) => ({ value: item.id, label: item.id })));
      if (!provider) return;
      const auth = runtime.getProvider(provider)?.auth;
      const credential = await this.ui.choose("Credentials", [
        { value: "existing", label: "Existing credentials or environment" },
        ...(auth?.apiKey?.login ? [{ value: "api_key", label: "Enter API key" }] : []),
        ...(auth?.oauth ? [{ value: "oauth", label: "Sign in with provider" }] : []),
      ]);
      if (!credential) return;
      if (credential === "api_key" || credential === "oauth") {
        await runtime.login(provider, credential, {
          prompt: async (prompt) => {
            const value = prompt.type === "select"
              ? await this.ui.choose(prompt.message, prompt.options.map((option) => ({ value: option.id, label: option.label, description: option.description })))
              : prompt.type === "secret"
                ? await this.ui.secret(prompt.message)
                : await this.ui.input(prompt.message);
            if (value === null) throw new Error("Provider sign-in cancelled.");
            return value;
          },
          notify: (event) => {
            if (event.type === "auth_url") this.ui.message("info", `${event.instructions ?? "Open this URL to sign in:"}\n${event.url}`);
            else if (event.type === "device_code") this.ui.message("info", `Open ${event.verificationUri} and enter code ${event.userCode}.`);
            else if (event.type === "info" || event.type === "progress") this.ui.message("info", event.message);
          },
        });
      }
      if (!runtime.hasConfiguredAuth(provider)) throw new Error(`No credentials configured for ${provider}.`);
      if (!runtime.getModels(provider).length) {
        const result = await runtime.refresh({ providers: [provider], allowNetwork: true, signal: AbortSignal.timeout(15000) });
        const error = result.errors.get(provider);
        if (error) throw error;
      }
      const models = await runtime.getAvailable(provider);
      if (!models.length) throw new Error(`No available models for ${provider} with these credentials.`);
      const model = await this.ui.choose("Model", models.map((item) => ({ value: item.id, label: item.name, description: item.id })));
      if (!model) return;
      request = { kind: "builtin", provider, model };
    } else {
      const provider = await this.ui.input("Custom provider ID"); if (!provider) return;
      const api = await this.ui.choose("API protocol", [
        { value: "openai-completions", label: "OpenAI Chat Completions" },
        { value: "openai-responses", label: "OpenAI Responses" },
        { value: "anthropic-messages", label: "Anthropic Messages" },
      ]);
      if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages") return;
      const baseUrl = await this.ui.input(api === "anthropic-messages" ? "API root URL (Pi appends /v1/messages)" : "API base URL"); if (!baseUrl) return;
      const model = await this.ui.input("Model ID"); if (!model) return;
      const name = await this.ui.input("Model name", model); if (!name) return;
      const input = await this.ui.choose("Model input", [{ value: "text", label: "Text" }, { value: "image", label: "Text and image" }]);
      if (input !== "text" && input !== "image") return;
      const reasoning = await this.ui.choose("Reasoning", [{ value: "false", label: "No" }, { value: "true", label: "Yes" }]);
      if (!reasoning) return;
      const contextWindowText = await this.ui.input("Context window (tokens)"); if (contextWindowText === null) return;
      const maxTokensText = await this.ui.input("Maximum output tokens"); if (maxTokensText === null) return;
      const contextWindow = Number(contextWindowText);
      const maxTokens = Number(maxTokensText);
      request = { kind: "custom", provider, api, baseUrl, model, name, input, reasoning: reasoning === "true", contextWindow, maxTokens };
      const credential = await this.ui.choose("Credentials", [
        { value: "existing", label: "Existing credentials or environment" },
        { value: "key", label: "Enter API key", description: "Stored in Pi auth.json" },
        { value: "env", label: "Environment variable" },
      ]);
      if (!credential) return;
      if (credential === "env") {
        const apiKeyEnv = await this.ui.input("API key environment variable name");
        if (!apiKeyEnv) return;
        request = { ...request, apiKeyEnv };
      }
      if (credential === "key") {
        key = await this.ui.secret("API key");
        if (!key) return;
      }
    }
    const model = await configureConnection(this.home, runtime, request, key ?? undefined);
    this.config = loadConfig(this.home);
    await this.session?.setModel(model);
    this.ui.message("info", `Configured ${model.provider}/${model.id}.`);
  }
}

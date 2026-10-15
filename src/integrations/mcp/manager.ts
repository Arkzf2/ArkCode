import { createHash } from "node:crypto";
import { join } from "node:path";
import { StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { createMcpExtension, type McpHostController, type McpServerEntry, type McpToolInvocation } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "../../app/types.js";
import { cleanOutput } from "../../tools/output.js";
import { loadMcpConfig, matchesMcpTool, mcpTarget, mcpToolEnabled, mcpWorkingDirectory, resolveMcpEnvironment, updateMcpConfig, type McpEntry, type McpServerConfig } from "./config.js";

type HostOptions = {
  home: string; cwd: string; trusted: boolean;
  canConnect: () => boolean;
  authorize: (request: ApprovalRequest) => Promise<boolean>;
  warning: (message: string) => void;
  createTransport?: (entry: McpEntry) => McpTransport;
};

/** Host policy and configuration around the official SDK extension. */
export class McpManager {
  private controller: McpHostController | null = null;
  private readonly entries = new WeakMap<McpServerEntry, McpEntry>();
  private readonly secrets = new WeakMap<McpServerEntry, string[]>();
  private readonly warnings = new Set<string>();
  private loginAbort: AbortController | null = null;
  readonly extension;

  constructor(private readonly options: HostOptions) {
    this.extension = createMcpExtension({
      agentDir: options.home,
      logPath: join(options.home, "mcp.log"),
      resources: false,
      canConnect: options.canConnect,
      loadConfig: () => {
        const loaded = loadMcpConfig(options);
        return { servers: loaded.entries.map((entry) => this.sdkEntry(entry)), errors: loaded.diagnostics, autoEnableCodemode: true };
      },
      createTransport: (entry, _cwd, authProvider) => {
        const host = this.hostEntry(entry);
        if (options.createTransport) return options.createTransport(host);
        const config = host.config;
        const resolve = (value: string) => {
          const resolved = resolveMcpEnvironment(value);
          this.secrets.get(entry)?.push(resolved);
          return resolved;
        };
        if (config.transport === "stdio") return new StdioTransport({ command: config.command, args: config.args,
          cwd: mcpWorkingDirectory(host, options.cwd), stderr: "pipe",
          env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, resolve(value)])),
        });
        const headers = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, resolve(value)]));
        if (config.bearerTokenEnvVar) {
          for (const key of Object.keys(headers)) if (key.toLowerCase() === "authorization") delete headers[key];
          headers.Authorization = `Bearer ${resolve(`\${${config.bearerTokenEnvVar}}`)}`;
        }
        this.secrets.get(entry)?.push(config.url, ...new URL(config.url).searchParams.values());
        return new StreamableHttpTransport({ url: config.url, headers, authProvider: config.bearerTokenEnvVar ? undefined : authProvider });
      },
      filterTool: (entry, tool) => mcpToolEnabled(this.hostEntry(entry).config, tool.name),
      startupTimeoutMs: (entry) => this.hostEntry(entry).config.startupTimeoutMs,
      sanitizeDiagnostic: (entry, message) => this.redact(entry, message),
      authorizeTool: (call) => this.authorize(call),
      updateConfig: (entry, patch) => updateMcpConfig(this.hostEntry(entry), patch),
      onController: (controller) => {
        this.controller = controller;
        controller.subscribe(() => {
          for (const server of controller.snapshot().servers) {
            if (!server.error) continue;
            const warning = `MCP ${server.entry.name}: ${this.redact(server.entry, server.error)}`;
            if (!this.warnings.has(warning)) { this.warnings.add(warning); options.warning(warning); }
          }
        });
      },
    });
  }

  get statuses() {
    return (this.controller?.snapshot().servers ?? []).map((server) => ({
      entry: this.hostEntry(server.entry), state: {
        kind: server.entry.config.enabled !== false && !this.options.canConnect() && server.state !== "connected" ? "blocked" : server.state,
        error: server.error,
      },
      canSignIn: server.canSignIn,
      canSignOut: server.canSignOut,
      tools: server.tools.map(({ name, tool, exposure }) => ({ name: tool.name, modelName: name,
        description: tool.description ?? tool.name, exposure, enabled: exposure !== "hidden" })),
    }));
  }

  statusText(): string {
    const rows = this.statuses.map(({ entry, state, tools }) =>
      `${entry.name}: ${state.kind}${state.error ? ` (${state.error})` : ""}, ${tools.filter((tool) => tool.enabled).length}/${tools.length} tools, ${entry.config.exposure}\n  ${entry.scope}: ${entry.source}\n  ${entry.config.transport}: ${mcpTarget(entry)}`);
    return cleanOutput([...rows, ...(this.controller?.snapshot().errors ?? []), ...(!rows.length ? ["No MCP servers configured."] : []),
    ].join("\n"));
  }

  helpText(): string {
    return cleanOutput([
      `Configuration: ${join(this.options.home, "mcp.json")} or ${join(this.options.cwd, ".arkcode", "mcp.json")}`,
      "Commands: /mcp tools <server>, /mcp reload, /mcp reconnect [server], /mcp enable|disable|login|logout <server>, /mcp exposure <server> <codemode|deferred|direct|hidden>",
      "Sign in is available when a remote server requests OAuth. Sign out is available when it has stored OAuth tokens. Local stdio servers do not use these actions.",
    ].join("\n"));
  }

  toolsText(name: string): string {
    const server = this.requireServer(name);
    return cleanOutput([`${name}: ${server.state.kind}`, ...server.tools.map((tool) =>
      `${tool.enabled ? "enabled" : "disabled"} ${tool.modelName} (${tool.exposure})\n  ${tool.name}: ${tool.description}`),
    ].join("\n"));
  }

  async waitReady(): Promise<void> { await this.control().waitReady(); }
  async reload(): Promise<void> { this.warnings.clear(); await this.control().reload(); }
  async reconnect(name?: string): Promise<void> { this.warnings.clear(); await this.control().reconnect(name); }
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    updateMcpConfig(this.requireServer(name).entry, { enabled });
    await this.control().reload(name);
  }
  async setExposure(name: string, exposure: McpServerConfig["exposure"]): Promise<void> {
    updateMcpConfig(this.requireServer(name).entry, { exposure });
    await this.control().reload(name);
  }
  async login(name: string, prompt: Parameters<McpHostController["login"]>[1]): Promise<void> {
    const abort = new AbortController();
    this.loginAbort = abort;
    try {
      const error = await this.control().login(name, prompt, abort.signal);
      if (error) throw new Error(error);
    }
    finally { if (this.loginAbort === abort) this.loginAbort = null; }
  }
  async logout(name: string): Promise<void> { await this.control().logout(name); }
  async cancelConnecting(): Promise<void> { this.loginAbort?.abort(); await this.controller?.cancelConnecting(); }
  async close(): Promise<void> { this.loginAbort?.abort(); await this.controller?.close(); }

  private control(): McpHostController {
    if (!this.controller) throw new Error("MCP extension is not bound to a session.");
    return this.controller;
  }
  private requireServer(name: string) {
    const server = this.statuses.find(({ entry }) => entry.name === name);
    if (!server) throw new Error(`Unknown MCP server ${name}. Use /mcp.`);
    return server;
  }
  private hostEntry(entry: McpServerEntry): McpEntry {
    const host = this.entries.get(entry);
    if (!host) throw new Error(`MCP server ${entry.name} has no trusted host configuration.`);
    return host;
  }
  private sdkEntry(entry: McpEntry): McpServerEntry {
    const config = entry.config;
    const common = { enabled: config.enabled, exposure: config.exposure, toolExposure: config.toolExposure,
      description: config.description, timeout: config.toolTimeoutMs / 1000 };
    const sdk: McpServerEntry = { name: entry.name, source: entry.source, scope: entry.scope === "user" ? "global" : "project",
      config: config.transport === "stdio"
        ? { ...common, type: "stdio", command: config.command, args: config.args, env: config.env, cwd: config.cwd }
        : { ...common, type: "http", url: config.url,
          headers: config.bearerTokenEnvVar ? { ...config.headers, Authorization: `\${${config.bearerTokenEnvVar}}` } : config.headers },
    };
    this.entries.set(sdk, entry);
    this.secrets.set(sdk, Object.entries(process.env).flatMap(([key, value]) => value && /TOKEN|SECRET|PASSWORD|API_?KEY|AUTH|CREDENTIAL/i.test(key) ? [value] : []));
    return sdk;
  }
  private redact(entry: McpServerEntry, message: string): string {
    for (const secret of (this.secrets.get(entry) ?? []).filter(Boolean).sort((a, b) => b.length - a.length)) message = message.replaceAll(secret, "[redacted]");
    return cleanOutput(message);
  }
  private async authorize(call: McpToolInvocation): Promise<void> {
    const entry = this.hostEntry(call.entry);
    call.signal?.throwIfAborted();
    if (!this.options.canConnect()) throw new Error("MCP execution is unavailable.");
    const invocation: NonNullable<ApprovalRequest["invocation"]> = {
      kind: "mcp", server: entry.name, tool: call.tool.name, source: entry.source,
      identity: `${entry.fingerprint}:${call.connectionId}:${createHash("sha256").update(JSON.stringify(call.tool)).digest("hex")}`,
      arguments: call.args, autoApprove: matchesMcpTool(call.tool.name, entry.config.autoApproveTools),
      destructive: call.tool.annotations?.destructiveHint === true,
    };
    if (!await this.options.authorize({ id: call.toolCallId, tool: call.name, cwd: this.options.cwd, invocation,
      description: cleanOutput(`MCP ${entry.name}/${call.tool.name}\nSource: ${entry.source}\nArguments:\n${JSON.stringify(call.args)}`),
    })) throw new Error("MCP tool execution denied.");
    call.signal?.throwIfAborted();
    if (!this.options.canConnect()) throw new Error("MCP execution is unavailable.");
  }
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { minimatch } from "minimatch";

const common = {
  enabled: z.boolean().default(true),
  exposure: z.enum(["codemode", "deferred", "direct", "hidden"]).default("codemode"),
  toolExposure: z.record(z.string(), z.enum(["codemode", "deferred", "direct", "hidden"])).optional(),
  description: z.string().optional(),
  enabledTools: z.array(z.string().min(1)).optional(),
  disabledTools: z.array(z.string().min(1)).default([]),
  autoApproveTools: z.array(z.string().min(1)).default([]),
  startupTimeoutMs: z.number().int().positive().max(300000).default(60000),
  toolTimeoutMs: z.number().int().positive().max(300000).default(30000),
};
const serverSchema = z.union([
  z.object({ ...common, transport: z.literal("stdio").default("stdio"), command: z.string().min(1),
    args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}), cwd: z.string().min(1).optional(),
  }).strict(),
  z.object({ ...common, transport: z.literal("http").default("http"),
    url: z.url().refine((value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    }, "Use an HTTP(S) URL without embedded credentials."),
    headers: z.record(z.string(), z.string()).default({}),
    bearerTokenEnvVar: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  }).strict(),
]);
const documentSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).strict();
const serverNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export type McpServerConfig = z.infer<typeof serverSchema>;
export interface McpEntry {
  name: string;
  source: string;
  scope: "user" | "project";
  config: McpServerConfig;
  fingerprint: string;
}
export interface McpConfiguration { entries: McpEntry[]; diagnostics: string[] }

export function mcpConfigurationErrors(config: Pick<McpConfiguration, "diagnostics">): string[] {
  return config.diagnostics.filter((message) => !message.startsWith("Project MCP configuration skipped in untrusted workspace:"));
}

function readDocument(path: string): z.infer<typeof documentSchema> {
  if (statSync(path).size > 1024 * 1024) throw new Error("MCP configuration exceeds 1 MiB.");
  return documentSchema.parse(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")));
}

export function loadMcpConfig(options: { home: string; cwd: string; trusted: boolean }): McpConfiguration {
  const entries = new Map<string, McpEntry>();
  const diagnostics: string[] = [];
  const sources: Array<{ path: string; scope: McpEntry["scope"] }> = [
    { path: join(options.home, "mcp.json"), scope: "user" },
    { path: join(options.cwd, ".arkcode", "mcp.json"), scope: "project" },
  ];
  for (const { path, scope } of sources) {
    if (!existsSync(path)) continue;
    if (scope === "project" && !options.trusted) {
      diagnostics.push(`Project MCP configuration skipped in untrusted workspace: ${path}`);
      continue;
    }
    let document;
    try { document = readDocument(path); }
    catch { diagnostics.push(`Cannot read MCP configuration: ${path}. Expected a JSON object with mcpServers.`); continue; }
    for (const [name, input] of Object.entries(document.mcpServers)) {
      entries.delete(name);
      if (!serverNameSchema.safeParse(name).success) {
        diagnostics.push(`Invalid MCP server name in ${path}. Use letters, numbers, dots, underscores or hyphens.`);
        continue;
      }
      const parsed = serverSchema.safeParse(input);
      if (!parsed.success) {
        diagnostics.push(`Invalid MCP server ${name} in ${path}. Use stdio command/args or a Streamable HTTP url; check supported fields and timeouts.`);
        continue;
      }
      if (scope === "project" && parsed.data.autoApproveTools.length) {
        diagnostics.push(`MCP server ${name}: autoApproveTools is only allowed in user mcp.json. Project server skipped.`);
        continue;
      }
      const fingerprint = createHash("sha256").update(JSON.stringify([path, parsed.data])).digest("hex");
      entries.set(name, { name, source: path, scope, config: parsed.data, fingerprint });
    }
  }
  return { entries: [...entries.values()], diagnostics };
}

export function setMcpEnabled(entry: McpEntry, enabled: boolean): void {
  updateMcpConfig(entry, { enabled });
}

export function updateMcpConfig(entry: McpEntry, patch: { enabled?: boolean; exposure?: McpServerConfig["exposure"] }): void {
  const document = readDocument(entry.source);
  const current = document.mcpServers[entry.name];
  const parsed = serverSchema.parse(current);
  const fingerprint = createHash("sha256").update(JSON.stringify([entry.source, parsed])).digest("hex");
  if (fingerprint !== entry.fingerprint) throw new Error("MCP configuration changed. Run /mcp reload first.");
  const original = z.record(z.string(), z.unknown()).parse(current);
  document.mcpServers[entry.name] = { ...original, ...patch };
  mkdirSync(dirname(entry.source), { recursive: true });
  const temporary = `${entry.source}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, entry.source);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function matchesMcpTool(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => name === pattern || minimatch(name, pattern, { dot: true }));
}

export function mcpToolEnabled(config: McpServerConfig, name: string): boolean {
  return (!config.enabledTools || matchesMcpTool(name, config.enabledTools)) && !matchesMcpTool(name, config.disabledTools);
}

export function mcpTarget(entry: McpEntry): string {
  if (entry.config.transport === "stdio") return entry.config.command;
  const url = new URL(entry.config.url);
  return `${url.origin}${url.pathname}`;
}

export function mcpWorkingDirectory(entry: McpEntry, workspace: string): string {
  return entry.config.transport === "stdio" && entry.config.cwd ? resolve(workspace, entry.config.cwd) : workspace;
}

export function resolveMcpEnvironment(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`Missing MCP environment variable ${name}.`);
    return resolved;
  });
}

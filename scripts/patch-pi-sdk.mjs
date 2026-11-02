import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const assets = fileURLToPath(new URL('./pi-sdk-patch/', import.meta.url));
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
if (version !== '1.5.0') throw new Error(`ArkCode's Pi SDK patch requires 1.5.0; installed ${version}. Review the patch before upgrading.`);

const normalize = (value) => value.replaceAll('\r\n', '\n');
const hash = (value) => createHash('sha256').update(normalize(value)).digest('hex');
const asset = (name) => normalize(readFileSync(join(assets, name), 'utf8'));
const replacements = new Map();
function patch(path, change) {
  const original = replacements.get(path)?.original ?? readFileSync(join(packageRoot, path), 'utf8');
  const text = replacements.get(path)?.text ?? normalize(original);
  replacements.set(path, { original, text: change(text) });
}
function replace(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`Pi SDK patch expected exactly one occurrence: ${before.slice(0, 120)}`);
  return text.replace(before, after);
}
function section(text, start, end, content) {
  const offset = text.indexOf(start);
  const stop = text.indexOf(end, offset);
  if (offset < 0 || stop < 0 || text.indexOf(start, offset + start.length) >= 0)
    throw new Error(`Pi SDK patch could not identify section: ${start}`);
  return text.slice(0, offset) + content + text.slice(stop);
}

const manifestPath = join(assets, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pending = Object.entries(manifest.files).filter(([path, checksums]) => {
  const current = hash(readFileSync(join(packageRoot, path), 'utf8'));
  if (current === checksums.patched) return false;
  if (current !== checksums.original && !(checksums.previousPatched ?? []).includes(current))
    throw new Error(`Pi SDK file changed unexpectedly: ${path}. Refusing to overwrite it.`);
  return true;
});
const updateManifest = process.argv.includes('--update-manifest');
if (pending.length === 0 && !updateManifest) process.exit(0);
// Recover the exact upstream files before computing changes, including after a partial installation.
for (const [path] of Object.entries(manifest.files)) {
  const target = join(packageRoot, path);
  const backup = join(packageRoot, '.arkcode-sdk-originals', path);
  if (!existsSync(backup)) {
    if (hash(readFileSync(target, 'utf8')) !== manifest.files[path].original)
      throw new Error(`Missing upstream backup for already patched file: ${path}`);
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, readFileSync(target));
  }
  const original = readFileSync(backup, 'utf8');
  if (hash(original) !== manifest.files[path].original) throw new Error(`Invalid upstream backup: ${path}`);
  replacements.set(path, { original, text: normalize(original) });
}

patch('dist/core/system-prompt.js', (text) => {
  text = replace(text, '        sections: { ...(input.sections ?? {}) },',
    '        sections: { ...(input.sections ?? {}) },\n        sectionProviders: { ...(input.sectionProviders ?? {}) },');
  text = replace(text, '    for (const name of Object.keys(customSections)) {',
    '    for (const [name, provide] of Object.entries(options.sectionProviders))\n        customSections[name] = provide();\n    for (const name of Object.keys(customSections)) {');
  return replace(text, '        if (content)\n            promptSections[name] = content;',
    '        if (content)\n            promptSections[name] = content;\n        else\n            delete promptSections[name];');
});
patch('dist/core/system-prompt.d.ts', (text) => {
  text = replace(text, '    sections?: Record<string, string>;',
    '    sections?: Record<string, string>;\n    /** Recomputed at each prompt build, including continuations after automatic compaction. */\n    sectionProviders?: Record<string, () => string>;');
  return replace(text, '    sections: Record<string, string>;',
    '    sections: Record<string, string>;\n    sectionProviders: Record<string, () => string>;');
});

patch('dist/core/agent-session.js', (text) => {
  text = replace(text, 'contentText, getCurrentSystemMessage, getCurrentTools, retryDelayMs', 'contentText, getCurrentSystemMessage, getCurrentTools, toToolDeclaration, retryDelayMs');
  text = replace(text, '        else {\n            // Normalize images after before_agent_start', '        else if (trigger.messageType !== "continuation") {\n            // Normalize images after before_agent_start');
  text = replace(text, '    async compact(customInstructions) {', asset('compaction-host.js') + '\n    async compact(customInstructions) {\n        if (this._hostCompaction) {\n            if (this.isStreaming) throw new Error("Wait until the current run finishes.");\n            return await this.runHostCompaction("manual", customInstructions);\n        }');
  return replace(text, '    async _checkCompaction(assistantMessage, skipAbortedCheck = true) {',
    '    async _checkCompaction(assistantMessage, skipAbortedCheck = true) {\n        if (this._hostCompaction) return await this._recoverHostOverflow(assistantMessage, skipAbortedCheck);');
});
patch('dist/core/agent-session.d.ts', (text) => replace(text, '    compact(customInstructions?: string): Promise<CompactionResult>;',
  asset('compaction-host.d.ts') + '\n    compact(customInstructions?: string): Promise<CompactionResult>;'));

patch('dist/core/session-manager.js', (text) => {
  text = replace(text, '    if (entry.type === "compaction") {\n        const summary = createCompactionSummaryMessage',
    '    if (entry.type === "compaction") {\n        if (entry.details?.arkcode !== undefined) {\n            const checkpoint = entry.details.arkcode;\n            if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.replacementMessages) || !Array.isArray(checkpoint.pendingEntryIds))\n                throw new Error("Invalid or unsupported ArkCode checkpoint version.");\n            return checkpoint.replacementMessages;\n        }\n        const summary = createCompactionSummaryMessage');
  return replace(text, '    const contextEntries = [compaction];',
    '    const contextEntries = [compaction];\n    if (compaction.details?.arkcode !== undefined) {\n        const checkpoint = compaction.details.arkcode;\n        if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.pendingEntryIds))\n            throw new Error("Invalid or unsupported ArkCode checkpoint version.");\n        const pending = new Set(checkpoint.pendingEntryIds);\n        contextEntries.push(...path.slice(0, compactionIdx).filter((entry) => pending.has(entry.id)));\n        contextEntries.push(...path.slice(compactionIdx + 1));\n        return contextEntries;\n    }');
});

patch('dist/core/tools/grep.js', (text) => replace(text,
  '                        args.push("--", pattern, searchPath);',
  '                        for (const pattern of options?.excludeGlobs ?? [])\n                            args.push("--iglob", `!${pattern}`);\n                        if (options?.maxFileBytes !== undefined)\n                            args.push("--max-filesize", String(options.maxFileBytes));\n                        args.push("--", pattern, searchPath);'));
patch('dist/core/tools/grep.d.ts', (text) => replace(text,
  'export interface GrepToolOptions {',
  'export interface GrepToolOptions {\n    /** Host exclusions applied after the model glob, case-insensitively. */\n    excludeGlobs?: string[];\n    /** Maximum bytes searched per file, enforced by ripgrep before reading matches. */\n    maxFileBytes?: number;'));

patch('dist/extensions/mcp/index.d.ts', (text) => replace(replace(text,
  'export interface McpExtensionOptions {', asset('host-api.d.ts') + '\nexport interface McpExtensionOptions {'),
  'export interface McpExtensionOptions {', 'export interface McpExtensionOptions {\n' + asset('host-options.d.ts')));
patch('dist/index.d.ts', (text) => replace(text,
  'export { createMcpExtension, type McpExtensionOptions, type McpTransportFactory } from "./extensions/mcp/index.ts";',
  'export { createMcpExtension, type McpExtensionOptions, type McpTransportFactory, type McpHostController, type McpHostSnapshot, type McpToolInvocation } from "./extensions/mcp/index.ts";\nexport type { McpSignInPrompt } from "./extensions/mcp/oauth.ts";'));

patch('dist/extensions/mcp/index.js', (text) => {
  text = replace(text, 'import { getAgentDir } from "../../config.js";', 'import { getAgentDir } from "../../config.js";\nimport { FileAuthStorageBackend } from "../../core/auth-storage.js";');
  text = replace(text, '        let modelRegistry;', '        let modelRegistry;\n        let hostContext;');
  text = replace(text, '            credentials ??= new runtime.McpOAuthCredentialStore();', '            const agentDir = options.agentDir ?? getAgentDir();\n            credentials ??= new runtime.McpOAuthCredentialStore(new FileAuthStorageBackend(join(agentDir, "mcp-auth.json")), agentDir);');
  text = replace(text, 'options.logPath ?? join(getAgentDir(), "mcp.log")', 'options.logPath ?? join(options.agentDir ?? getAgentDir(), "mcp.log")');
  text = replace(text, '            for (const tool of connection.tools) {\n                const definition', '            for (const tool of connection.tools) {\n                if (options.filterTool?.(entry, tool) === false)\n                    continue;\n                const definition');
  text = section(text, '                    getClient: async () => {', '                    readableResources:', asset('get-tool-client.js'));
  text = replace(text, '                definitions.set(definition.name, definition);', '                definition.executionMode = "sequential";\n                definitions.set(definition.name, definition);');
  text = replace(text, '        const serversWithResources = () => servers.filter(', '        const serversWithResources = () => options.resources === false ? [] : servers.filter(');
  text = replace(text, '                credentials: getCredentials(runtime),', '                credentials: getCredentials(runtime),\n                canConnect: () => isCurrent() && options.canConnect?.() !== false,\n                startupTimeoutMs: options.startupTimeoutMs?.(server.entry),\n                sanitizeDiagnostic: (text) => options.sanitizeDiagnostic?.(server.entry, text) ?? text,');
  text = replace(text, '            modelRegistry = ctx.modelRegistry;', '            modelRegistry = ctx.modelRegistry;\n            hostContext = ctx;');
  text = section(text, '        pi.on("session_shutdown", async () => {', '        pi.registerCommand("mcp", {', '        pi.on("session_shutdown", async () => closeHost());\n' + asset('host-controller.js'));
  return text;
});

patch('dist/extensions/mcp/tools.js', (text) => replace(text,
  '            const client = await options.getClient();', '            const client = await options.getClient(_toolCallId, params, signal);'));
patch('dist/extensions/mcp/tools.d.ts', (text) => replace(text,
  '    getClient: () => Promise<McpToolCaller>;', '    getClient: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolCaller>;'));

patch('dist/extensions/mcp/runtime.js', (text) => {
  text = replace(text, 'import { homedir } from "node:os";', 'import { homedir } from "node:os";\nimport { randomUUID } from "node:crypto";');
  text = replace(text, '    log;\n    constructor(options)', '    log;\n    canConnect;\n    startupTimeoutMs;\n    sanitizeDiagnostic;\n    connectionId;\n    constructor(options)');
  text = replace(text, '        this.log = options.log;', '        this.log = options.log;\n        this.canConnect = options.canConnect;\n        this.startupTimeoutMs = options.startupTimeoutMs;\n        this.sanitizeDiagnostic = options.sanitizeDiagnostic ?? ((text) => text);');
  text = replace(text, '        if (this.client?.connectionState === "connected")', '        if (this.canConnect?.() === false)\n            return Promise.reject(new Error("MCP connections are currently disabled by the host."));\n        if (this.client?.connectionState === "connected")');
  text = replace(text, '    readResource(uri, options) {', '    callToolGuarded(name, args, options, authorize) {\n        return this.withClient(async (client) => {\n            options.signal?.throwIfAborted();\n            const connectionId = this.connectionId;\n            await authorize(connectionId);\n            options.signal?.throwIfAborted();\n            if (this.closed || this.canConnect?.() === false || this.client !== client || this.connectionId !== connectionId || client.connectionState !== "connected")\n                throw new Error("MCP connection changed while awaiting authorization; retry the tool call.");\n            return client.callTool(name, args, options);\n        });\n    }\n    readResource(uri, options) {');
  text = section(text, '    async open() {', '    async connectOnce() {', asset('open-connection.js'));
  text = replace(text, '    async connectOnce() {', '    async connectOnce(signal) {');
  text = replace(text, '            requestTimeoutMs: this.timeoutMs,', '            requestTimeoutMs: this.startupTimeoutMs ?? this.timeoutMs,');
  text = replace(text, '        this.shutdown.signal.addEventListener("abort", closeClient, { once: true });', '        signal.addEventListener("abort", closeClient, { once: true });');
  text = replace(text, '            transport = this.createTransport(this.entry, this.cwd, this.authProvider);', '            signal.throwIfAborted();\n            transport = this.createTransport(this.entry, this.cwd, this.authProvider);');
  text = replace(text, '            if (this.closed)\n                throw new Error("shut down while connecting");', '            signal.throwIfAborted();\n            if (this.closed)\n                throw new Error("shut down while connecting");');
  text = replace(text, '            this.client = client;\n            this.tools = tools;', '            this.client = client;\n            this.connectionId = randomUUID();\n            this.tools = tools;');
  text = replace(text, 'transport.stderr.trim().slice(-STDERR_TAIL_CHARS)', 'this.sanitizeDiagnostic(transport.stderr).trim().slice(-STDERR_TAIL_CHARS)');
  text = replace(text, '        this.shutdown.signal.removeEventListener("abort", closeClient);', '        signal.removeEventListener("abort", closeClient);');
  text = replace(text, 'this.stderrTail ? `${errorMessage(error)}\\n${this.stderrTail}` : errorMessage(error)', 'this.sanitizeDiagnostic(this.stderrTail ? `${errorMessage(error)}\\n${this.stderrTail}` : errorMessage(error))');
  text = replace(text, 'stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS)', 'this.sanitizeDiagnostic(stdio?.stderr ?? "").trim().slice(-STDERR_TAIL_CHARS)');
  text = replace(text, '`Failed to refresh tools: ${errorMessage(error)}`', 'this.sanitizeDiagnostic(`Failed to refresh tools: ${errorMessage(error)}`)');
  return text;
});
patch('dist/extensions/mcp/runtime.d.ts', (text) => {
  text = replace(text, '        entry: McpServerEntry;', '        canConnect?: () => boolean;\n        startupTimeoutMs?: number;\n        sanitizeDiagnostic?: (text: string) => string;\n        entry: McpServerEntry;');
  return replace(text, '    readResource(uri:', '    callToolGuarded(name: string, args: Record<string, unknown>, options: McpRequestOptions, authorize: (connectionId: string) => Promise<void>): Promise<CallToolResult>;\n    readResource(uri:');
});

// Validate every output before writing any file. Hashes deliberately cover normalized line endings.
if (updateManifest) {
  for (const [path, { text }] of replacements) {
    const checksum = manifest.files[path];
    const next = hash(text);
    if (checksum.patched !== next && checksum.patched !== checksum.original)
      checksum.previousPatched = [...new Set([...(checksum.previousPatched ?? []), checksum.patched])];
    checksum.patched = next;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
for (const [path, { text }] of replacements) {
  if (hash(text) !== manifest.files[path].patched) throw new Error(`Pi SDK patch output checksum mismatch: ${path}`);
}
for (const [path] of updateManifest ? Object.entries(manifest.files) : pending) writeFileSync(join(packageRoot, path), replacements.get(path).text);

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createExtensionRuntime, ModelRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { Permission } from "./domain.js";

const permissionSchema = z.enum(["read-only", "ask", "full-access"]) satisfies z.ZodType<Permission>;
const legacyDeepSeekProviderSchema = z.object({
  baseUrl: z.literal("https://api.deepseek.com/v1"),
  api: z.literal("openai-completions"),
  apiKey: z.literal("${DEEPSEEK_API_KEY}"),
  models: z.tuple([z.object({ id: z.literal("deepseek-flash"), name: z.literal("DeepSeek Flash").optional() }).strict()]),
}).passthrough();
export const arkConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("medium"),
  permission: permissionSchema.default("ask"),
  trustedWorkspaces: z.array(z.string().min(1)).default([]),
}).strict();
export type ArkConfig = z.infer<typeof arkConfigSchema>;
const modelId = z.string().trim().min(1);
const providerId = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Use letters, numbers, dots, underscores, or hyphens for provider IDs.");
const connectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), provider: providerId, model: modelId }),
  z.object({
    kind: z.literal("custom"), provider: providerId, model: modelId, name: modelId,
    api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
    baseUrl: z.url(), input: z.enum(["text", "image"]), reasoning: z.boolean(),
    contextWindow: z.number().int().positive(), maxTokens: z.number().int().positive(),
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  }),
]);
export type ConnectionRequest = z.infer<typeof connectionSchema>;
const legacySettingsSchema = arkConfigSchema.extend({
  theme: z.enum(["dark", "light"]).optional(),
  statusline: z.enum(["compact", "expanded"]).optional(),
}).strict();

export function loadConfig(home: string): ArkConfig {
  const path = join(home, "settings.json");
  if (!existsSync(path)) return arkConfigSchema.parse({});
  try {
    const { theme: _theme, statusline: _statusline, ...current } = legacySettingsSchema.parse(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")));
    return arkConfigSchema.parse(current);
  } catch (error) {
    throw new Error(`Cannot load ArkCode settings at ${path}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveConfig(home: string, config: ArkConfig): void {
  const validated = arkConfigSchema.parse(config);
  mkdirSync(home, { recursive: true });
  const path = join(home, "settings.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function upgradeLegacyDeepSeekModel(path: string): void {
  if (!existsSync(path)) return;
  let source: unknown;
  try { source = JSON.parse(readFileSync(path, "utf8")); }
  catch { return; }
  const document = z.object({ providers: z.record(z.string(), z.unknown()) }).passthrough().safeParse(source);
  if (!document.success) return;
  const provider = legacyDeepSeekProviderSchema.safeParse(document.data.providers.deepseek);
  if (!provider.success) return;
  const updated = { ...document.data, providers: { ...document.data.providers, deepseek: { ...provider.data, models: [] } } };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export async function createModelRuntime(home: string): Promise<ModelRuntime> {
  mkdirSync(home, { recursive: true });
  const modelsPath = join(home, "models.json");
  upgradeLegacyDeepSeekModel(modelsPath);
  const runtime = await ModelRuntime.create({
    authPath: join(home, "auth.json"),
    modelsPath,
    modelsStorePath: join(home, "model-cache.json"),
    allowModelNetwork: false,
  });
  const error = runtime.getError();
  if (error) throw new Error(error);
  return runtime;
}

export async function selectModel(
  runtime: ModelRuntime,
  selector?: string,
  config?: Pick<ArkConfig, "provider" | "model">,
): Promise<Model<Api> | undefined> {
  const available = await runtime.getAvailable();
  if (selector) {
    const separator = selector.indexOf("/");
    const provider = separator >= 0 ? selector.slice(0, separator) : undefined;
    const id = separator >= 0 ? selector.slice(separator + 1) : selector;
    const candidates = runtime.getModels().filter((model) => model.id === id && (!provider || model.provider === provider));
    if (candidates.length === 0) throw new Error(`Unknown model "${selector}". Run arkcode models to list models.`);
    const selected = available.find((model) => candidates.some((candidate) => candidate.provider === model.provider && candidate.id === model.id));
    if (!selected) throw new Error(`No credentials configured for model "${selector}". Run arkcode config or configure the provider environment variable.`);
    if (!provider && candidates.length > 1) {
      const preferred = available.find((model) => model.id === id && model.provider === config?.provider);
      if (preferred) return preferred;
    }
    return selected;
  }
  const preferred = available.find((model) => model.provider === config?.provider && model.id === config?.model);
  return preferred;
}

export async function configureConnection(home: string, runtime: ModelRuntime, request: ConnectionRequest, apiKey?: string): Promise<Model<Api>> {
  const selected = connectionSchema.parse(request);
  const existing = runtime.getModel(selected.provider, selected.model);
  if (selected.kind === "builtin") {
    if (!builtinProviders().some((provider) => provider.id === selected.provider)) throw new Error(`Provider ${selected.provider} is not a Pi built-in provider.`);
    if (!existing) throw new Error(runtime.getModels(selected.provider).length
      ? `Unknown Pi model ${selected.provider}/${selected.model}.`
      : `Pi has not discovered models for ${selected.provider}. Configure credentials with /connect and retry.`);
  } else {
    const url = new URL(selected.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) endpoint without embedded credentials.");
    if (selected.api === "anthropic-messages" && /\/v1\/?$/.test(url.pathname)) throw new Error("Anthropic base URL must be the API root; Pi appends /v1/messages.");
    if (selected.maxTokens > selected.contextWindow) throw new Error("Max tokens cannot exceed the context window.");
    if (builtinProviders().some((provider) => provider.id === selected.provider)) {
      throw new Error(`Provider ${selected.provider} belongs to Pi. Choose a distinct custom provider ID.`);
    }
    const path = join(home, "models.json");
    const hadFile = existsSync(path);
    const source = hadFile ? readFileSync(path, "utf8") : "{}\n";
    const errors: ParseError[] = [];
    const document: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length || !document || typeof document !== "object" || Array.isArray(document)) throw new Error(`Invalid models.json at ${path}.`);
    const root = document as Record<string, unknown>;
    if (root.providers !== undefined && (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers))) throw new Error(`Invalid providers in ${path}.`);
    const providers = root.providers as Record<string, unknown> | undefined;
    const previous = providers?.[selected.provider];
    if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous))) throw new Error(`Invalid provider ${selected.provider} in ${path}.`);
    const provider = previous as Record<string, unknown> | undefined;
    if (provider?.models !== undefined && !Array.isArray(provider.models)) throw new Error(`Invalid models for ${selected.provider} in ${path}.`);
    const models = (provider?.models ?? []) as unknown[];
    if (models.length && (provider?.baseUrl !== selected.baseUrl || provider?.api !== selected.api)) {
      throw new Error(`Provider ${selected.provider} already has models on a different endpoint or API. Use a distinct provider ID.`);
    }
    const model = { id: selected.model, name: selected.name, input: selected.input === "image" ? ["text", "image"] : ["text"],
      reasoning: selected.reasoning, contextWindow: selected.contextWindow, maxTokens: selected.maxTokens };
    const index = models.findIndex((entry) => !!entry && typeof entry === "object" && "id" in entry && entry.id === selected.model);
    const pathToProvider = ["providers", selected.provider];
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };
    let updated = source;
    const fields: Array<[string, unknown]> = [["baseUrl", selected.baseUrl], ["api", selected.api]];
    if (selected.apiKeyEnv) fields.push(["apiKey", "${" + selected.apiKeyEnv + "}"]);
    for (const [key, value] of fields) updated = applyEdits(updated, modify(updated, [...pathToProvider, key], value, options));
    const modelPath = [...pathToProvider, "models"];
    if (index >= 0) {
      for (const [key, value] of Object.entries(model)) {
        updated = applyEdits(updated, modify(updated, [...modelPath, index, key], value, options));
      }
    } else if (provider?.models) updated = applyEdits(updated, modify(updated, [...modelPath, -1], model, options));
    else updated = applyEdits(updated, modify(updated, modelPath, [model], options));
    mkdirSync(home, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, updated, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    try {
      const result = await runtime.refresh({ allowNetwork: false });
      const error = result.errors.get(selected.provider)?.message;
      if (error || !runtime.getModel(selected.provider, selected.model)) throw new Error(error ?? `Pi could not load ${selected.provider}/${selected.model}.`);
    } catch (error) {
      if (hadFile) {
        const rollback = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(rollback, source, { flag: "wx", mode: 0o600 });
          renameSync(rollback, path);
        } finally { if (existsSync(rollback)) unlinkSync(rollback); }
      } else unlinkSync(path);
      await runtime.refresh({ allowNetwork: false });
      throw error;
    }
  }
  const model = runtime.getModel(selected.provider, selected.model);
  if (!model) throw new Error(`Pi could not load ${selected.provider}/${selected.model}.`);
  if (apiKey) await runtime.login(selected.provider, "api_key", { prompt: async () => apiKey, notify: () => {} });
  const available = await runtime.getAvailable(selected.provider);
  if (!available.some((entry) => entry.id === selected.model)) throw new Error(`Credentials missing for ${selected.provider}. Set its API key before selecting ${selected.model}.`);
  saveConfig(home, { ...loadConfig(home), provider: selected.provider, model: selected.model });
  return model;
}

function readInstructions(cwd: string): Array<{ path: string; content: string }> {
  const directories: string[] = [];
  let current = resolve(cwd);
  while (true) {
    directories.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const files: Array<{ path: string; content: string }> = [];
  let remaining = 128 * 1024;
  for (const directory of directories) {
    const path = join(directory, "AGENTS.md");
    if (!existsSync(path) || remaining <= 0) continue;
    const descriptor = openSync(path, "r");
    try {
      const limit = Math.min(64 * 1024, remaining);
      const buffer = Buffer.alloc(limit + 1);
      const count = readSync(descriptor, buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, Math.min(count, limit)).toString("utf8").replace(/^\uFEFF/, "");
      files.push({ path, content: content + (count > limit ? "\n[Instructions truncated at the ArkCode size limit.]" : "") });
      remaining -= Math.min(count, limit);
    } finally {
      closeSync(descriptor);
    }
  }
  return files;
}

export function createResources(cwd: string, trusted: boolean): ResourceLoader {
  let agentsFiles = trusted ? readInstructions(cwd) : [];
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const prompt = "You are ArkCode, a terminal coding agent. Inspect the project before making changes. Follow project instructions. Keep changes focused, verify the result, and report what changed and what was checked. Never claim a command succeeded without its result. Tool permissions are enforced by the host. Do not bypass a denied tool action.";
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => { agentsFiles = trusted ? readInstructions(cwd) : []; },
  };
}

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createExtensionRuntime, ModelRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { z } from "zod";
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
  if (process.env.DEEPSEEK_API_KEY && !existsSync(modelsPath)) {
    const models = { providers: { deepseek: {
      baseUrl: "https://api.deepseek.com/v1",
      api: "openai-completions",
      apiKey: "${DEEPSEEK_API_KEY}",
    } } };
    try { writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
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
  const deepseek = !config?.model && process.env.DEEPSEEK_API_KEY
    ? available.find((model) => model.provider === "deepseek" && model.id === "deepseek-flash")
    : undefined;
  return preferred ?? deepseek ?? available[0];
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

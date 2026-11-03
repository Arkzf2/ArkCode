import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { TSchema } from "typebox";
import { minimatch } from "minimatch";
import { z } from "zod";
import { createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
  createReadToolDefinition, createWriteToolDefinition,
  generateDiffString,
  detectSupportedImageMimeTypeFromFile, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "../app/types.js";
import type { ManagedShell } from "./shell.js";
import type { ToolOutputFiles } from "./output-files.js";
import type { SkillsManager } from "../integrations/skills.js";
import { collect, readBuffer, workspacePath } from "./workspace.js";

import { createShellTools } from "./shell-tools.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const TOOL_NAMES = ["read", "write", "edit", "grep", "glob", "bash", "shell_control"];
export const READ_TOOL_NAMES = ["read", "grep", "glob"];
const invocationSchema = z.union([z.object({ command: z.string() }), z.object({ path: z.string() })]);


export function createTools(options: {
  cwd: string;
  authorize: (request: ApprovalRequest) => Promise<boolean>;
  shell: ManagedShell;
  outputFiles?: ToolOutputFiles;
  skills?: SkillsManager;
}): ToolDefinition[] {
  const { cwd, authorize, shell, outputFiles, skills } = options;
  const readPath = async (path: string) => await skills?.resolve(cwd, path) ?? await outputFiles?.resolve(cwd, path) ?? workspacePath(cwd, path);
  const wrap = <T extends TSchema, D, S>(name: string, tool: ToolDefinition<T, D, S>): Omit<ToolDefinition<T, D, S>, "renderCall" | "renderResult"> => {
    const { renderCall: _renderCall, renderResult: _renderResult, ...definition } = tool;
    return {
      ...definition,
      name,
      label: name,
      promptGuidelines: definition.promptGuidelines?.map((guideline) => guideline.replace(/\b(find|powershell)\b/g,
        (toolName) => toolName === "find" ? "glob" : "bash")),
      async execute(id, params, signal, onUpdate, ctx) {
        signal?.throwIfAborted();
        const args = invocationSchema.safeParse(params);
        const invocation: ApprovalRequest["invocation"] = !args.success ? undefined : "command" in args.data
          ? { kind: "shell", command: args.data.command, shell: shell.executable }
          : { kind: "file", path: args.data.path };
        if (invocation?.kind === "file") {
          if (name === "read") await readPath(invocation.path);
          else await workspacePath(cwd, invocation.path, name === "write" || name === "edit");
        }
        const description = `${name}\nArguments:\n${JSON.stringify(params)}`;
        if (!await authorize({ id, tool: name, description, cwd, invocation })) throw new Error("Tool execution denied.");
        signal?.throwIfAborted();
        return tool.execute(id, params, signal, onUpdate, ctx);
      },
    };
  };
  const writeFileGuarded = async (path: string, content: string) => {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Content exceeds the 2 MiB text limit.");
    await writeFile(await workspacePath(cwd, path, true), content, "utf8");
  };
  const readDefinition = createReadToolDefinition(cwd, {
    operations: {
      access: async (path) => access(await readPath(path)),
      readFile: async (path) => await skills?.read(cwd, path) ?? await outputFiles?.read(cwd, path) ?? readBuffer(cwd, path, false, true),
      detectImageMimeType: async (path) => detectSupportedImageMimeTypeFromFile(await readPath(path)),
    },
  });
  const read = wrap("read", {
    ...readDefinition,
    async execute(id, params, signal, update, ctx) {
      const artifact = await outputFiles?.resolve(cwd, params.path);
      if (artifact && !await detectSupportedImageMimeTypeFromFile(artifact)) {
        const text = await outputFiles?.readText(cwd, params.path, { offset: params.offset, limit: params.limit, signal });
        if (text !== undefined) return { content: [{ type: "text", text }], details: undefined, structuredContent: text };
      }
      return readDefinition.execute(id, params, signal, update, ctx);
    },
  });
  const { renderCall: _writeCall, renderResult: _writeResult, ...writeDefinition } = createWriteToolDefinition(cwd);
  const write = wrap<typeof writeDefinition.parameters, { diff: string } | undefined, unknown>("write", {
    ...writeDefinition,
    async execute(id, params, signal, update, ctx) {
      let diff: string | undefined;
      const result = await createWriteToolDefinition(cwd, { operations: {
        mkdir: async (path) => { await mkdir(await workspacePath(cwd, path, true), { recursive: true }); },
        writeFile: async (path, content) => {
          let before: string | null = null;
          try { before = (await readBuffer(cwd, path, true)).toString("utf8"); }
          catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") before = ""; }
          await writeFileGuarded(path, content);
          if (before !== null && Buffer.byteLength(before) + Buffer.byteLength(content) <= 256 * 1024) {
            diff = generateDiffString(before.replace(/\r\n?/g, "\n"), content.replace(/\r\n?/g, "\n")).diff;
          }
        },
      } }).execute(id, params, signal, update, ctx);
      return { ...result, details: diff === undefined ? undefined : { diff } };
    },
  });
  const edit = wrap("edit", createEditToolDefinition(cwd, {
    operations: {
      access: async (path) => access(await workspacePath(cwd, path, true)),
      readFile: (path) => readBuffer(cwd, path, true),
      writeFile: writeFileGuarded,
    },
  }));
  const findDefinition = createFindToolDefinition(cwd);
  const find = wrap("glob", {
    ...findDefinition,
    description: "Find workspace files by glob pattern, excluding dependency, metadata and credential paths. Returns paths relative to the search directory.",
    promptSnippet: "Find workspace files by glob pattern",
    async execute(id, params, signal, update, ctx) {
      const definition = createFindToolDefinition(cwd, {
        operations: {
          exists: async (path) => { await stat(await workspacePath(cwd, path)); return true; },
          glob: async (pattern, path, { limit }) => (await collect(cwd, path, signal))
            .filter((file) => minimatch(relative(path, file).split(sep).join("/"), pattern, {
              matchBase: true, dot: true, nocase: process.platform === "win32",
            })).slice(0, limit),
        },
      });
      return definition.execute(id, params, signal, update, ctx);
    },
  });
  const grep = wrap("grep", createGrepToolDefinition(cwd, {
    maxFileBytes: MAX_FILE_BYTES,
    excludeGlobs: ["**/.git/**", "**/.arkcode/**", "**/node_modules/**", "**/.env", "**/.env.*"],
    operations: {
      isDirectory: async (path) => (await stat(await workspacePath(cwd, path))).isDirectory(),
      readFile: async (path) => (await readBuffer(cwd, path)).toString("utf8"),
    },
  }));
  return [read, write, edit, grep, find, ...createShellTools(options)];
}

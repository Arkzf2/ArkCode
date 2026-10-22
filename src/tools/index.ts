import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { TSchema } from "typebox";
import { minimatch } from "minimatch";
import { z } from "zod";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
  createPowerShellToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  generateDiffString,
  detectSupportedImageMimeTypeFromFile, type BashOperations, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "../app/types.js";
import type { ManagedShell, ShellReceipt } from "./shell.js";
import type { ToolOutputFiles } from "./output-files.js";
import type { SkillsManager } from "../integrations/skills.js";
import { collect, readBuffer, workspacePath } from "./workspace.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const TOOL_NAMES = ["read", "write", "edit", "grep", "glob", "bash"];
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
  const read = wrap("read", createReadToolDefinition(cwd, {
    operations: {
      access: async (path) => access(await readPath(path)),
      readFile: async (path) => await skills?.read(cwd, path) ?? await outputFiles?.read(cwd, path) ?? readBuffer(cwd, path, false, true),
      detectImageMimeType: async (path) => detectSupportedImageMimeTypeFromFile(await readPath(path)),
    },
  }));
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
  const createShell = process.platform === "win32" ? createPowerShellToolDefinition : createBashToolDefinition;
  const shellDefinition = createShell(cwd, { exposeSessionEnvironment: false });
  const bash = wrap("bash", {
    ...shellDefinition,
    description: `${shellDefinition.description} Runs in ${shell.executable} with your OS privileges; commands can access paths outside the workspace.`,
    async execute(id, params, signal, update, ctx) {
      if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout < 1 || params.timeout > 600)) {
        throw new Error("Shell timeout must be between 1 and 600 seconds.");
      }
      let receipt: ShellReceipt | undefined;
      const operations: BashOperations = {
        async exec(command, _cwd, { signal: shellSignal, timeout, onData }) {
          const controller = new AbortController();
          const abort = () => controller.abort();
          shellSignal?.addEventListener("abort", abort, { once: true });
          if (shellSignal?.aborted) controller.abort();
          const timer = timeout === undefined ? undefined : setTimeout(abort, timeout * 1000);
          try {
            receipt = await shell.execute(command, controller.signal, undefined, onData);
            if (receipt.status === "cancelled") onData(Buffer.from("\n[Command cancelled]"));
            return { exitCode: receipt.status === "cancelled" ? 130 : receipt.exitCode };
          } finally {
            if (timer) clearTimeout(timer);
            shellSignal?.removeEventListener("abort", abort);
          }
        },
      };
      const definition = createShell(cwd, { operations, exposeSessionEnvironment: false });
      const result = await definition.execute(id, params, signal, update, ctx);
      return { ...result, details: { ...result.details, ...receipt,
        ...(receipt?.status === "cancelled" ? { exitCode: 130, processExitCode: receipt.exitCode } : {}),
      } };
    },
  });
  return [read, write, edit, grep, find, bash];
}

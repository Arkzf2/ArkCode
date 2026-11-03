import { createBashToolDefinition, createPowerShellToolDefinition, truncateTail, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "../app/types.js";
import { bashInputSchema, shellControlInputSchema, shellResultSchema, shellControlDescription, shellDescriptionAppend,
  parseShellArguments, type ShellError } from "./shell-contract.js";
import { ManagedShell, ShellOperationError, type ShellObservation } from "./shell.js";
import type { ToolOutputFiles } from "./output-files.js";

export function createShellTools(options: { cwd: string; shell: ManagedShell; outputFiles?: ToolOutputFiles; authorize: (request: ApprovalRequest) => Promise<boolean> }): ToolDefinition[] {
  const { cwd, shell, outputFiles, authorize } = options;
  const success = (observation: ShellObservation) => ({
    content: [{ type: "text", text: observation.text } satisfies { type: "text"; text: string }],
    structuredContent: observation.result,
    details: { ...observation.receipt, status: observation.result.status, ...(observation.result.output_file ? { fullOutputPath: observation.result.output_file } : {}) },
  });
  const failure = (error: unknown) => {
    const known = error instanceof ShellOperationError ? error : new ShellOperationError("internal_error", error instanceof Error ? error.message : String(error));
    const result: ShellError = { kind: "error", error: { code: known.code, message: known.message },
      ...(known.snapshot ? { session: known.snapshot } : {}), ...(known.delivery ? { input: { state: known.delivery } } : {}),
    };
    return { content: [{ type: "text", text: JSON.stringify(result) } satisfies { type: "text"; text: string }], structuredContent: result, isError: true, details: undefined };
  };
  const exported = async (path: string) => { await outputFiles?.capture("shell_control", { fullOutputPath: path }); };
  const definition = (shell.kind === "powershell" ? createPowerShellToolDefinition : createBashToolDefinition)(cwd, { exposeSessionEnvironment: false });
  const bash: ToolDefinition<typeof bashInputSchema> = {
    name: "bash", label: "bash", description: definition.description.replace("50KB", "50 KiB") + shellDescriptionAppend,
    promptSnippet: definition.promptSnippet, parameters: bashInputSchema, outputSchema: shellResultSchema, constrainedSampling: false,
    executionMode: "parallel",
    prepareArguments: args => parseShellArguments(bashInputSchema, args),
    async execute(id, raw, signal, update) {
      const params = parseShellArguments(bashInputSchema, raw);
      signal?.throwIfAborted();
      let active = true;
      let preview = "";
      let updated = 0;
      try {
        if (!await authorize({ id, tool: "bash", cwd, description: `bash\nArguments:\n${JSON.stringify(params)}`, invocation: { kind: "shell", command: params.command, shell: shell.executable } })) {
          throw new ShellOperationError("permission_denied", "Shell command denied. The command did not start.");
        }
        signal?.throwIfAborted();
        return success(await shell.once(`bash:${id}`, () => shell.launch(params, { signal, exportFile: exported,
          onData(data) {
            if (!active) return;
            preview = truncateTail(preview + data.toString("utf8")).content;
            if (Date.now() - updated >= 100) { updated = Date.now(); update?.({ content: [{ type: "text", text: preview }], details: undefined }); }
          },
        })));
      } catch (error) { if (signal?.aborted) throw error; return failure(error); }
      finally { active = false; }
    },
  };
  const control: ToolDefinition<typeof shellControlInputSchema> = {
    name: "shell_control", label: "shell_control", description: shellControlDescription,
    parameters: shellControlInputSchema, outputSchema: shellResultSchema, constrainedSampling: false, executionMode: "parallel",
    prepareArguments: args => parseShellArguments(shellControlInputSchema, args),
    async execute(id, raw, signal) {
      const params = parseShellArguments(shellControlInputSchema, raw);
      signal?.throwIfAborted();
      try {
        const session = shell.describe(params.session_id);
        const invocation: ApprovalRequest["invocation"] = { kind: "shell_control", action: params.action, session_id: params.session_id,
          command: session.command, shell: session.shell, ...(params.action === "send" ? { data: params.data, eof: params.eof ?? false } : {}),
        };
        if (!await authorize({ id, tool: "shell_control", cwd, invocation, description: `shell_control\nCommand: ${session.command}\nArguments:\n${JSON.stringify(params)}` })) {
          throw new ShellOperationError("permission_denied", "Shell control denied. No input was sent or cancellation requested.", undefined, params.action === "send" ? "not_sent" : undefined);
        }
        signal?.throwIfAborted();
        return success(await shell.once(`shell_control:${id}`, () => shell.control(params, { signal, exportFile: exported })));
      } catch (error) { if (signal?.aborted) throw error; return failure(error); }
    },
  };
  return [bash, control];
}

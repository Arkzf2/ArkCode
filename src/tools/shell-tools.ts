import { createBashToolDefinition, createPowerShellToolDefinition, truncateTail, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "../app/types.js";
import { bashInputSchema, shellControlInputSchema, shellResultSchema, shellControlDescription, shellDescriptionAppend,
  parseShellArguments, ShellArgumentError, type ShellError } from "./shell-contract.js";
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
    const argument = error instanceof ShellArgumentError ? error : undefined;
    const known = error instanceof ShellOperationError ? error : new ShellOperationError(argument ? "invalid_arguments" : "internal_error", error instanceof Error ? error.message : String(error));
    const hints: Partial<Record<ShellError["error"]["code"], string>> = {
      invalid_arguments: "Correct the named field and retry. No shell process was started.",
      spawn_failed: "Check the selected shell and working directory before retrying.",
      session_not_found: "Use the session_id returned by the current bash call; do not guess an OS PID.",
      session_expired: "This session belongs to an earlier agent run. Start a new command only when the old result is no longer needed.",
      session_limit: "Collect or stop an existing session before starting another command.",
      observation_in_progress: "Wait for the existing observation or use input/stop; do not start a duplicate wait.",
      stdin_closed: "This session's input is closed. Start a new bash command if more input is required.",
      eof_not_supported: "The PTY session is still usable. Send terminal input through chars, or start a pipe session when the program needs a real EOF.",
      process_exited: "The process is already terminal; inspect its status and exit_code instead of resending input.",
      stdin_write_failed: "Input delivery is unknown. Do not resend automatically; observe the same session first.",
      permission_denied: "No command, input, or cancellation was performed. Change permission or retry after approval.",
      internal_error: "Inspect the returned message and session snapshot before retrying.",
    };
    const retryable = !["permission_denied", "session_not_found", "session_expired", "stdin_closed", "process_exited"].includes(known.code);
    const result: ShellError = { kind: "error", error: { code: known.code, message: known.message,
      ...(argument?.field ? { field: argument.field } : {}), ...(argument?.hint ? { hint: argument.hint } : { hint: hints[known.code] }), retryable },
      ...(known.snapshot ? { session: known.snapshot } : {}), ...(known.delivery ? { input: { state: known.delivery } } : {}),
    };
    return { content: [{ type: "text", text: JSON.stringify(result) } satisfies { type: "text"; text: string }], structuredContent: result, isError: true, details: undefined };
  };
  const exported = async (path: string) => { await outputFiles?.capture("shell_control", { fullOutputPath: path }); };
  const definition = (shell.kind === "powershell" ? createPowerShellToolDefinition : createBashToolDefinition)(cwd, { exposeSessionEnvironment: false });
  const bashDescription = definition.description.replace("50KB", "50 KiB").replace(/ Optionally provide a timeout in seconds\.$/i, "");
  const bash: ToolDefinition<typeof bashInputSchema> = {
    name: "bash", label: "bash", description: bashDescription + shellDescriptionAppend,
    promptSnippet: definition.promptSnippet, parameters: bashInputSchema, outputSchema: shellResultSchema, constrainedSampling: false,
    executionMode: "parallel",
    prepareArguments: args => parseShellArguments(bashInputSchema, args),
    async execute(id, raw, signal, update) {
      let active = true;
      let preview = "";
      let updated = 0;
      try {
        const params = parseShellArguments(bashInputSchema, raw);
        signal?.throwIfAborted();
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
      try {
        const params = parseShellArguments(shellControlInputSchema, raw);
        signal?.throwIfAborted();
        const session = shell.describe(params.session_id);
        const sendsInput = params.action === "wait" && ((params.chars?.length ?? 0) > 0 || params.eof === true);
        const invocation: ApprovalRequest["invocation"] = { kind: "shell_control", action: params.action, session_id: params.session_id,
          command: session.command, shell: session.shell, ...(sendsInput ? { chars: params.chars, eof: params.eof ?? false } : {}),
        };
        if (!await authorize({ id, tool: "shell_control", cwd, invocation, description: `shell_control\nCommand: ${session.command}\nArguments:\n${JSON.stringify(params)}` })) {
          throw new ShellOperationError("permission_denied", sendsInput ? "Shell control denied. No input was sent." : "Shell control denied. No observation or cancellation was performed.", undefined, sendsInput ? "not_sent" : undefined);
        }
        signal?.throwIfAborted();
        return success(await shell.once(`shell_control:${id}`, () => shell.control(params, { signal, exportFile: exported })));
      } catch (error) { if (signal?.aborted) throw error; return failure(error); }
    },
  };
  return [bash, control];
}

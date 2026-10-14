#!/usr/bin/env node
import { parseCli, HELP } from "./app/args.js";
import { ArkHost } from "./app/host.js";
import { configureConnection, createModelRuntime, type ConnectionRequest } from "./config/settings.js";
import { PlainUI, TerminalUI } from "./ui/terminal.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCli(argv);
  if (options.help) { process.stdout.write(HELP); return; }
  if (options.version) { process.stdout.write("0.1.0\n"); return; }
  if (options.command === "config") {
    if (!options.provider || !options.model) throw new Error("Use arkcode config --provider NAME --model ID.");
    const custom = Boolean(options.baseUrl || options.api || options.contextWindow || options.maxTokens || options.input || options.reasoning || options.name);
    if (!custom && options.apiKeyEnv) throw new Error("--api-key-env applies only to a custom endpoint. Pi built-in providers use their own environment variable or stored credentials.");
    let request: ConnectionRequest;
    if (custom) {
      if (!options.baseUrl || !options.api || !options.contextWindow || !options.maxTokens || !options.input || !options.reasoning) {
        throw new Error("Custom endpoints require --base-url, --api, --context-window, --max-tokens, --input, and --reasoning.");
      }
      if (options.api !== "openai-completions" && options.api !== "openai-responses" && options.api !== "anthropic-messages") throw new Error("Unsupported API protocol.");
      if (options.input !== "text" && options.input !== "image") throw new Error("Input must be text or image.");
      if (options.reasoning !== "true" && options.reasoning !== "false") throw new Error("Reasoning must be true or false.");
      request = { kind: "custom", provider: options.provider, model: options.model, name: options.name ?? options.model,
        baseUrl: options.baseUrl, api: options.api, input: options.input, reasoning: options.reasoning === "true",
        contextWindow: Number(options.contextWindow), maxTokens: Number(options.maxTokens), apiKeyEnv: options.apiKeyEnv };
    } else request = { kind: "builtin", provider: options.provider, model: options.model };
    const runtime = await createModelRuntime(options.home);
    await configureConnection(options.home, runtime, request);
    process.stdout.write(`Configured ${options.provider}/${options.model} in ${options.home}.\n`);
    return;
  }
  if (options.command === "models") {
    const runtime = await createModelRuntime(options.home);
    for (const model of await runtime.getAvailable()) process.stdout.write(`${model.provider}/${model.id}\n`);
    return;
  }
  if (!options.print && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    if (options.prompt) options.print = true;
    else throw new Error("Interactive mode requires a terminal. Use --print with a prompt, or pipe input with --print.");
  }
  if (options.print && !options.prompt && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) throw new Error("Piped prompt exceeds 1 MiB.");
      chunks.push(buffer);
    }
    options.prompt = Buffer.concat(chunks).toString("utf8");
  }
  if (options.print && !options.prompt) throw new Error("Print mode requires a prompt.");
  let host: ArkHost | null = null;
  const ui = options.print ? new PlainUI({ json: options.json, approve: options.approve }) : new TerminalUI({
    submit: async (text, mode) => { await host?.submit(text, mode); },
    interrupt: async () => { await host?.interrupt(); },
    exit: async () => { await host?.exit(); },
    editPrevious: async () => { await host?.editPrevious(); },
    browseSessions: async () => { await host?.browseSessions(); },
  });
  host = new ArkHost(options, ui);
  const close = () => { void host?.exit().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }); };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  try {
    if (ui instanceof TerminalUI) ui.start();
    await host.start();
    if (options.prompt) await host.submit(options.prompt);
    if (options.print) {
      const outcome = host.outcome;
      if (outcome === "failed" || outcome === null) process.exitCode = 1;
      else if (outcome === "interrupted") process.exitCode = 130;
      await host.exit();
    }
  } catch (error) { await host.exit(); throw error; }
  finally {
    if (options.print) { process.off("SIGINT", close); process.off("SIGTERM", close); }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`ArkCode: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

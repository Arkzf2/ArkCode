import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { parsePermission } from "../permissions/policy.js";

const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function parseCli(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    cwd: { type: "string", short: "C" }, home: { type: "string" },
    model: { type: "string", short: "m" }, thinking: { type: "string" },
    permissions: { type: "string" }, "full-access": { type: "boolean" },
    "read-only": { type: "boolean" }, print: { type: "boolean", short: "p" },
    json: { type: "boolean" }, approve: { type: "boolean" },
    last: { type: "boolean" }, help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    provider: { type: "string" }, "base-url": { type: "string" },
    api: { type: "string" }, "api-key-env": { type: "string" },
    name: { type: "string" }, input: { type: "string" }, reasoning: { type: "string" },
    "context-window": { type: "string" }, "max-tokens": { type: "string" }, trust: { type: "boolean" },
  }});
  if (values["full-access"] && values["read-only"]) throw new Error("Choose one permission preset.");
  if (values["read-only"]) parsePermission("read-only");
  const command = ["resume", "fork", "config", "models"].includes(positionals[0] ?? "") ? positionals.shift() : undefined;
  return {
    cwd: resolve(values.cwd ?? process.cwd()),
    home: resolve(values.home ?? process.env.ARKCODE_HOME ?? resolve(homedir(), ".arkcode")),
    model: values.model, thinking: values.thinking ? thinkingSchema.parse(values.thinking) : undefined,
    permission: values["full-access"] ? parsePermission("never-ask") : values.permissions ? parsePermission(values.permissions) : undefined,
    print: Boolean(values.print || values.json), json: Boolean(values.json), approve: Boolean(values.approve),
    last: Boolean(values.last), help: Boolean(values.help), version: Boolean(values.version),
    provider: values.provider, baseUrl: values["base-url"], api: values.api,
    name: values.name, input: values.input, reasoning: values.reasoning,
    contextWindow: values["context-window"], maxTokens: values["max-tokens"],
    apiKeyEnv: values["api-key-env"], trust: Boolean(values.trust),
    command, target: (command === "resume" || command === "fork") && !values.last ? positionals.shift() : undefined,
    prompt: positionals.join(" "),
  };
}
export type CliOptions = ReturnType<typeof parseCli>;

export const HELP = `ArkCode 0.1.0

Usage: arkcode [options] [prompt]
       arkcode resume [session-id | --last]
       arkcode fork <session-id>
       arkcode models
       arkcode config --provider NAME --model ID
       arkcode config --provider NAME --model ID --base-url URL --api API
         --context-window N --max-tokens N --input text|image --reasoning true|false
         [--name NAME] [--api-key-env NAME]

  API is openai-completions, openai-responses, or anthropic-messages.
  Anthropic base URL is the API root; Pi appends /v1/messages.

  -C, --cwd PATH           Workspace directory
  -m, --model PROVIDER/ID  Select a configured Pi model
      --thinking LEVEL    off, minimal, low, medium, high, xhigh, max
      --permissions MODE  always-ask, ask-when-needed, never-ask
      --full-access       Alias for --permissions never-ask
      --trust             Trust project AGENTS.md, Skills, and MCP server configuration
  -p, --print             Run one prompt without a TUI
      --json              Emit JSON events
      --approve           Approve requested actions in print mode
      --home PATH         ArkCode configuration directory
  -h, --help              Show help

Six built-in tools remain available in every approval mode; connected MCP tools are exposed dynamically.
Always Ask allows workspace reading/search and plain ls; other actions and MCP calls need approval.
Ask When Needed allows ordinary built-in actions; dangerous commands and MCP tools without user auto-approval ask.
Never Ask runs without tool approval. Untrusted directories skip project AGENTS.md, Skills, and MCP; user configuration still applies.
Use /connect to configure a Pi provider or custom endpoint.
Use /mcp to inspect servers and tools, reload configuration, reconnect, or enable/disable servers.
Use /skills to list or enable/disable Skills from user and project .agents/skills. @ searches files and Skills; @skill:name selects one.
Use /tool-mode to choose direct, codemode, or codemode-only for built-in tools; changes apply after compact or to new sessions.
Use /web-search [status|check|on|off] for provider Web Search. Check runs a real search and can incur provider fees.
Print mode requires --model or a saved default model.
Use /new for another concurrent session; /sessions opens the session list. Left also works on an empty composer.
Switching sessions keeps background runs active. Another terminal opening the same session is read-only.
/exit stops all sessions owned by this terminal. Edit/Write use Pi's in-process same-file queue.
`;

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const permissionSchema = z.enum(["read-only", "ask", "full-access"]);
const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function parseCli(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    cwd: { type: "string", short: "C" }, home: { type: "string" },
    model: { type: "string", short: "m" }, thinking: { type: "string" },
    permissions: { type: "string" }, "full-access": { type: "boolean" },
    "read-only": { type: "boolean" }, print: { type: "boolean", short: "p" },
    json: { type: "boolean" }, approve: { type: "boolean" },
    last: { type: "boolean" }, help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" }, sandbox: { type: "string" },
    provider: { type: "string" }, "base-url": { type: "string" },
    "api-key-env": { type: "string" }, trust: { type: "boolean" },
  }});
  if (values.sandbox && values.sandbox !== "none") throw new Error("Sandbox is not available in this release. Use --sandbox none.");
  if (values["full-access"] && values["read-only"]) throw new Error("Choose one permission preset.");
  const command = ["resume", "fork", "config", "models"].includes(positionals[0] ?? "") ? positionals.shift() : undefined;
  return {
    cwd: resolve(values.cwd ?? process.cwd()),
    home: resolve(values.home ?? process.env.ARKCODE_HOME ?? resolve(homedir(), ".arkcode")),
    model: values.model, thinking: values.thinking ? thinkingSchema.parse(values.thinking) : undefined,
    permission: values["full-access"] ? permissionSchema.parse("full-access") : values["read-only"] ? permissionSchema.parse("read-only") : values.permissions ? permissionSchema.parse(values.permissions) : undefined,
    print: Boolean(values.print || values.json), json: Boolean(values.json), approve: Boolean(values.approve),
    last: Boolean(values.last), help: Boolean(values.help), version: Boolean(values.version),
    provider: values.provider, baseUrl: values["base-url"], apiKeyEnv: values["api-key-env"], trust: Boolean(values.trust),
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
       arkcode config --provider NAME --model ID [--base-url URL --api-key-env NAME]

  -C, --cwd PATH           Workspace directory
  -m, --model PROVIDER/ID  Select a configured Pi model
      --thinking LEVEL    off, minimal, low, medium, high, xhigh, max
      --permissions MODE  read-only, ask, full-access
      --full-access       Execute with your OS privileges
      --read-only         Disable shell and writing tools
      --trust             Trust workspace AGENTS.md text
  -p, --print             Run one prompt without a TUI
      --json              Emit JSON events
      --approve           Approve writes in print mode
      --home PATH         ArkCode configuration directory
  -h, --help              Show help

No OS sandbox. Ask confirms every write and command. Untrusted directories
start Read Only unless you explicitly choose a permission preset.
Use DEEPSEEK_API_KEY with --model deepseek/deepseek-flash.
`;

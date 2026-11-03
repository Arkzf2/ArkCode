import { mkdir, writeFile } from "node:fs/promises";
import { createShellTools } from "../src/tools/shell-tools.ts";
import { ManagedShell } from "../src/tools/shell.ts";
import { bashInputSchema, shellControlInputSchema, shellResultSchema } from "../src/tools/shell-contract.ts";

const directory = new URL("../docs/architecture/shell-control/", import.meta.url);
const tools = createShellTools({ cwd: process.cwd(), shell: new ManagedShell(process.cwd(), "bash"), authorize: async () => true });
await mkdir(directory, { recursive: true });
for (const [name, schema, description] of [
  ["bash.input.schema.json", bashInputSchema, tools.find(tool => tool.name === "bash")?.description],
  ["shell_control.input.schema.json", shellControlInputSchema, tools.find(tool => tool.name === "shell_control")?.description],
  ["shell.result.schema.json", shellResultSchema, "Programmatic shell result. Direct text uses its independent 2000-line/50-KiB tail preview. CodeMode applies its own limits to script-emitted output."],
]) {
  await writeFile(new URL(name, directory), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", description, ...schema }, null, 2) + "\n");
}
console.log("Generated shell schemas from the implementation.");

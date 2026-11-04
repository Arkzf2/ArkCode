import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createShellTools } from "../src/tools/shell-tools.ts";
import { ManagedShell } from "../src/tools/shell.ts";
import { bashInputSchema, shellControlInputSchema, shellResultSchema } from "../src/tools/shell-contract.ts";

const directory = new URL("../docs/shared/schemas/", import.meta.url);
const tools = createShellTools({ cwd: process.cwd(), shell: new ManagedShell(process.cwd(), "bash"), authorize: async () => true });
const check = process.argv.includes("--check") || new URL(import.meta.url).searchParams.has("check");
if (!check) await mkdir(directory, { recursive: true });
for (const [name, schema, description] of [
  ["bash.input.schema.json", bashInputSchema, tools.find(tool => tool.name === "bash")?.description],
  ["shell_control.input.schema.json", shellControlInputSchema, tools.find(tool => tool.name === "shell_control")?.description],
  ["shell.result.schema.json", shellResultSchema, "Programmatic shell result. Direct text uses its independent 2000-line/50-KiB tail preview. CodeMode applies its own limits to script-emitted output."],
]) {
  const content = JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", description, ...schema }, null, 2) + "\n";
  if (check) {
    if ((await readFile(new URL(name, directory), "utf8")).replaceAll("\r\n", "\n") !== content) throw new Error(`Stale shell schema: ${name}. Run npm run schemas:shell.`);
  } else await writeFile(new URL(name, directory), content);
}
console.log(check ? "Shell schemas match the implementation." : "Generated shell schemas from the implementation.");

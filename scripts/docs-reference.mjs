import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { documentationArtifacts, root } from "./docs-artifacts.mjs";

for (const [name, content] of await documentationArtifacts()) {
  const target = join(root, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}
await import("./shell-schemas.mjs");
console.log("Generated CLI, commands, settings defaults and built-in tool contracts.");

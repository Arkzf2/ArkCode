import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../dist/", import.meta.url));
if (!output.startsWith(root)) throw new Error("Build output must stay inside the package.");
rmSync(output, { recursive: true, force: true });
const compiler = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

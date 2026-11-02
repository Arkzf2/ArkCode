import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolOutputFiles } from "../src/tools/output-files.js";

test("CodeMode output registration grants only the disclosed, unchanged file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arkcode-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "output.txt");
  const sibling = join(root, "private.txt");
  await writeFile(path, "full result");
  await writeFile(sibling, "private data");
  const files = new ToolOutputFiles();
  await files.capture("read", { fullOutputPath: sibling });
  await files.capture("codemode", { fullOutputPath: path });
  assert.equal((await files.read(root, path))?.toString(), "full result");
  assert.equal(await files.read(root, sibling), undefined);
  assert.equal(await files.read(root, "unknown.txt"), undefined);
  await writeFile(path, "changed result");
  await assert.rejects(files.read(root, path), /Saved tool output changed/);
  assert.equal(await readFile(sibling, "utf8"), "private data");
});

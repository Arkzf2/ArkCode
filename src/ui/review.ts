import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanOutput } from "../tools/output.js";

const execute = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-c", "core.quotepath=false", "--no-pager", ...args], {
    cwd, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

export async function getBranch(cwd: string): Promise<string> {
  try {
    const name = (await git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim();
    return cleanOutput(name);
  } catch {
    try { return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim() + " (detached)"; }
    catch { return "No Git"; }
  }
}

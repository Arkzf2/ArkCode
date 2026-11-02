import assert from "node:assert/strict";
import test from "node:test";
import { ManagedShell } from "../src/tools/shell.js";

test("Windows shell preserves Chinese in receipts, updates and streamed tool output", { skip: process.platform !== "win32" }, async (t) => {
  const shell = new ManagedShell(process.cwd(), "powershell.exe");
  t.after(() => shell.stopAll());
  const chunks: Buffer[] = [];
  const updates: string[] = [];
  const receipt = await shell.execute(
    '$today = Get-Date \'2026-10-27\'; $next = Get-Date \'2027-10-01\'; "今天: $($today.ToString(\'yyyy-MM-dd\'))"; "距离 2027-10-01 还有 $([int]($next - $today).TotalDays) 天"',
    undefined, (update) => updates.push(update.output), (data) => chunks.push(data),
  );
  const expected = "今天: 2026-10-27\r\n距离 2027-10-01 还有 339 天\r\n";
  assert.equal(receipt.output, expected);
  assert.equal(receipt.exitCode, 0);
  assert.equal(updates.at(-1), expected);
  assert.equal(Buffer.concat(chunks).toString("utf8"), expected);
});

test("Windows shell preserves UTF-8 stderr and Chinese piped to native commands", { skip: process.platform !== "win32" }, async (t) => {
  const shell = new ManagedShell(process.cwd(), "powershell.exe");
  t.after(() => shell.stopAll());
  const stderr = await shell.execute('[Console]::Error.WriteLine("错误：中文输出 😀")');
  assert.equal(stderr.output, "错误：中文输出 😀\r\n");
  const piped = await shell.execute('\'中文输入 😀\' | node -e "process.stdin.pipe(process.stdout)"');
  assert.equal(piped.output, "中文输入 😀\r\n");
});

test("bounded shell receipts never cut a UTF-8 character", async (t) => {
  const shell = new ManagedShell(process.cwd());
  t.after(() => shell.stopAll());
  const receipt = await shell.execute('node -e "process.stdout.write(\'a\'.repeat(131071) + String.fromCodePoint(0x4e2d))"');
  assert.equal(receipt.truncated, true);
  assert.equal(receipt.output, "a".repeat(131071));
});

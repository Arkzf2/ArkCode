import { execFile } from "node:child_process";
import { posix } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const dynamic = "\u0000dynamic";
const invocationSchema = z.object({ name: z.string(), args: z.array(z.string()) });
const powershellSchema = z.object({ valid: z.boolean(), listing: z.boolean(), commands: z.array(invocationSchema) });
const bashParserPath = createRequire(import.meta.url).resolve("bash-parser");
const bashNodeSchema = z.object({ type: z.string(), text: z.string().optional(), name: z.unknown().optional(), suffix: z.array(z.unknown()).optional(), expansion: z.array(z.unknown()).optional(), prefix: z.array(z.unknown()).optional() }).passthrough();
const dangerousNames = new Set(["shutdown", "reboot", "poweroff", "halt", "kexec", "bcdedit", "diskpart", "format", "mkfs", "wipefs", "stop-computer", "restart-computer", "format-volume", "clear-disk", "initialize-disk"]);
const wrappers = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "nice", "builtin"]);
const privilegeValueOptions = new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-T", "--command-timeout", "-U", "--other-user", "-r", "--role", "-t", "--type"]);
const launchValueOptions = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "-n", "--adjustment"]);
const nestedShells = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash"]);

export interface ShellInspection {
  listing: boolean;
  dangerous: string | null;
  analyzable: boolean;
}

// Submitted commands are parser input, never executable code in the inspection process.
const powershellParser = `
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ARKCODE_POLICY_SOURCE))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
$nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true))
$commands = @($nodes | ForEach-Object {
  $name = $_.GetCommandName()
  if ($null -eq $name) { $name = [string][char]0 + 'dynamic' }
  $arguments = @($_.CommandElements | Select-Object -Skip 1 | ForEach-Object {
    if ($_ -is [Management.Automation.Language.StringConstantExpressionAst] -or $_ -is [Management.Automation.Language.ConstantExpressionAst]) { [string]$_.Value }
    elseif ($_ -is [Management.Automation.Language.CommandParameterAst]) { $_.Extent.Text }
    elseif ($_ -is [Management.Automation.Language.ExpandableStringExpressionAst] -and $_.NestedExpressions.Count -eq 0) { [string]$_.Value }
    else { [string][char]0 + 'dynamic' }
  })
  @{ name = $name; args = $arguments }
})
$listing = $false
if ($errors.Count -eq 0 -and $nodes.Count -eq 1 -and $ast.EndBlock.Statements.Count -eq 1) {
  $statement = $ast.EndBlock.Statements[0]
  if ($statement -is [Management.Automation.Language.PipelineAst] -and $statement.PipelineElements.Count -eq 1 -and $statement.PipelineElements[0] -is [Management.Automation.Language.CommandAst]) {
    $node = $statement.PipelineElements[0]
    $listing = $node.Redirections.Count -eq 0 -and $node.InvocationOperator -eq 'Unknown' -and $commands[0].name -in @('ls','Get-ChildItem') -and -not ($commands[0].args -match ([string][char]0))
  }
}
@{ valid = ($errors.Count -eq 0); listing = [bool]$listing; commands = $commands } | ConvertTo-Json -Depth 8 -Compress
`;

function commandName(name: string): string {
  return posix.basename(name.replaceAll("\\", "/")).toLowerCase().replace(/\.exe$/, "");
}

function safeTempTarget(target: string): boolean {
  if (target.includes(dynamic) || /[$`~?*\[\]{}]/.test(target) || target.split(/[\\/]/).includes("..")) return false;
  const normalized = posix.normalize(target);
  return ["/tmp", "/temp"].some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function dropOptions(args: string[], valueOptions: Set<string>): string[] {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") return args.slice(index + 1);
    if (arg === "-" || !arg.startsWith("-")) return args.slice(index);
    if (!arg.includes("=") && valueOptions.has(arg)) index++;
  }
  return [];
}

async function dangerousInvocation(name: string, args: string[], powershell: boolean, depth: number): Promise<string | null> {
  const nativeExecutable = /\.exe$/i.test(name);
  name = commandName(name);
  if (dangerousNames.has(name) || name.startsWith("mkfs.")) return name;
  if ((name === "init" || name === "telinit") && args.some((arg) => arg === "0" || arg === "6")) return name;
  if (name === "systemctl" && ["poweroff", "reboot", "halt", "kexec"].includes(dropOptions(args, new Set(["-H", "--host", "-M", "--machine"]))[0] ?? "")) return "systemctl";
  if (name === "dd" && args.some((arg) => arg.startsWith("of=/dev/") && !["of=/dev/null", "of=/dev/zero", "of=/dev/full", "of=/dev/random", "of=/dev/urandom", "of=/dev/stdin", "of=/dev/stdout", "of=/dev/stderr"].includes(arg))) return "dd";
  if (["rm", "remove-item", "del", "erase", "ri", "rd", "rmdir"].includes(name)) {
    const psRemoval = powershell && !nativeExecutable;
    let recursive = false, force = false, optionsEnded = false;
    const targets: string[] = [];
    for (const arg of args) {
      if (!psRemoval && arg === "--" && !optionsEnded) { optionsEnded = true; continue; }
      if (optionsEnded || !arg.startsWith("-")) { targets.push(arg); continue; }
      recursive ||= psRemoval ? /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::true|:\$true)?$/i.test(arg) : arg === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg);
      force ||= psRemoval ? /^-f(?:o(?:r(?:c(?:e)?)?)?)?(?::true|:\$true)?$/i.test(arg) : arg === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg);
    }
    if (recursive && force && !(targets.length > 0 && targets.every(safeTempTarget))) return name;
  }
  if (wrappers.has(name) || name === "busybox") {
    if (name === "command" && args.some((arg) => /^-[vV]+$/.test(arg))) return null;
    const rest = name === "busybox" ? args : dropOptions(args, ["sudo", "doas"].includes(name) ? privilegeValueOptions : launchValueOptions);
    let inner = name === "env" && rest[0] === "-" ? 1 : 0;
    if (name === "env") while (/^[\w]+=/u.test(rest[inner] ?? "")) inner++;
    if (inner < rest.length) return dangerousInvocation(rest[inner] ?? "", rest.slice(inner + 1), powershell, depth);
  }
  if (depth >= 4) return null;
  if (nestedShells.has(name)) {
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
    const source = args[flag + 1];
    if (flag >= 0 && source && !source.includes(dynamic)) return (await inspectPosix(source, depth + 1)).dangerous;
  }
  if (name === "eval" && !args.some((arg) => arg.includes(dynamic))) return (await inspectPosix(args.join(" "), depth + 1)).dangerous;
  return null;
}

async function inspectPosix(source: string, depth = 0): Promise<ShellInspection> {
  try {
    // Isolate parser work so malformed input has a bounded CPU and output budget.
    const { stdout } = await execute(process.execPath, ["-e", "const parse = require(process.env.ARKCODE_PARSER_MODULE); try { process.stdout.write(JSON.stringify(parse(Buffer.from(process.env.ARKCODE_POLICY_SOURCE, 'base64').toString('utf8')))); } catch { process.stdout.write('null'); }"], {
      windowsHide: true, timeout: 1000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ARKCODE_PARSER_MODULE: bashParserPath, ARKCODE_POLICY_SOURCE: Buffer.from(source).toString("base64") },
    });
    const root = z.object({ type: z.literal("Script"), commands: z.array(z.unknown()) }).parse(JSON.parse(stdout));
    const stack: unknown[] = [root];
    const commands: z.infer<typeof bashNodeSchema>[] = [];
    let count = 0;
    while (stack.length) {
      if (++count > 10000) return { listing: false, dangerous: null, analyzable: false };
      const value = stack.pop();
      if (Array.isArray(value)) { stack.push(...value); continue; }
      const node = bashNodeSchema.safeParse(value);
      if (!node.success) continue;
      // This parser does not fully support heredocs; do not mistake their body for commands.
      if (["dless", "dlessdash"].includes(node.data.type)) return { listing: false, dangerous: null, analyzable: false };
      if (node.data.type === "Command") commands.push(node.data);
      stack.push(...Object.values(node.data).filter((child) => typeof child === "object" && child !== null));
    }
    const literal = (word: unknown): string => {
      const node = bashNodeSchema.safeParse(word);
      return node.success && node.data.type === "Word" && !node.data.expansion?.length ? node.data.text ?? dynamic : dynamic;
    };
    let dangerous: string | null = null;
    for (const node of commands) {
      const args = (node.suffix ?? []).filter((word) => bashNodeSchema.safeParse(word).data?.type === "Word").map(literal);
      dangerous ??= await dangerousInvocation(literal(node.name), args, false, depth);
    }
    const node = commands[0];
    const listing = root.commands.length === 1 && commands.length === 1 && node !== undefined && literal(node.name) === "ls" && !node.prefix?.length
      && (node.suffix ?? []).every((word) => literal(word) !== dynamic) && !source.includes("$") && !source.includes("`");
    return { listing, dangerous, analyzable: true };
  } catch { return { listing: false, dangerous: null, analyzable: false }; }
}

async function parsePowerShell(command: string, shell: string) {
  const { stdout } = await execute(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(powershellParser, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
    env: { ...process.env, ARKCODE_POLICY_SOURCE: Buffer.from(command).toString("base64") },
  });
  return powershellSchema.parse(JSON.parse(stdout.replace(/^\uFEFF/, "")));
}

export async function inspectShell(command: string, shell: string, depth = 0): Promise<ShellInspection> {
  if (Buffer.byteLength(command) > 128 * 1024 || depth > 4) return { listing: false, dangerous: null, analyzable: false };
  if (!/(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)) return inspectPosix(command, depth);
  try {
    const parsed = await parsePowerShell(command, shell);
    let dangerous: string | null = null;
    for (const invocation of parsed.commands) {
      dangerous ??= await dangerousInvocation(invocation.name, invocation.args, true, depth);
      const name = commandName(invocation.name);
      if (["powershell", "pwsh", "invoke-expression", "iex"].includes(name)) {
        const flag = invocation.args.findIndex((arg) => /^-(?:command|c|encodedcommand|enc)$/i.test(arg));
        const source = ["invoke-expression", "iex"].includes(name) ? invocation.args[0] : flag >= 0 ? invocation.args[flag + 1] : undefined;
        if (source && !source.includes(dynamic)) {
          const text = /^(?:-encodedcommand|-enc)$/i.test(invocation.args[flag] ?? "") ? Buffer.from(source, "base64").toString("utf16le") : source;
          dangerous ??= (await inspectShell(text, shell, depth + 1)).dangerous;
        }
      }
    }
    return { listing: parsed.valid && parsed.listing, dangerous, analyzable: parsed.valid };
  } catch { return { listing: false, dangerous: null, analyzable: false }; }
}
